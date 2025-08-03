/**
 * Embedding service using TNG Internal Embedding Server with chunking and rate limiting
 */

import type {
    AppConfig,
    ArticleChunk,
    ZendeskArticle,
    Embedding,
    RateLimitState,
    RetryOptions,
    ChunkingOptions,
    Logger,
    EmbeddingResponse,
    SafeError,
} from './types.ts';
import { parseError } from './types.ts';

export class EmbeddingService {
    private config: AppConfig['tngEmbedding'];
    private timeoutMs: number;
    private rateLimitState: RateLimitState;
    private retryOptions: RetryOptions;
    private logger: Logger;

    constructor(config: AppConfig['tngEmbedding'], timeoutMs: number, logger: Logger) {
        this.config = config;
        this.timeoutMs = timeoutMs;
        this.logger = logger;

        // Initialize rate limit state
        this.rateLimitState = {
            requests: [],
            tokens: [],
        };

        // Retry configuration
        this.retryOptions = {
            maxRetries: 3,
            baseDelay: 1000,
            maxDelay: 30000,
            backoffFactor: 2,
        };
    }

    /**
     * Process articles into chunks and create embeddings
     */
    async processArticles(
        articles: ZendeskArticle[],
        chunkingOptions: ChunkingOptions,
    ): Promise<{ chunks: ArticleChunk[]; embeddings: Embedding[] }> {
        this.logger.info(`Processing ${articles.length} articles into chunks and embeddings...`);
        const startTime = Date.now();

        const allChunks: ArticleChunk[] = [];
        const allEmbeddings: Embedding[] = [];

        for (let i = 0; i < articles.length; i++) {
            const article = articles[i];
            const articleStartTime = Date.now();

            this.logger.info(`[${i + 1}/${articles.length}] Processing "${article.title}" (ID: ${article.id})`);

            // Memory monitoring for large processing jobs
            if ((i + 1) % 10 === 0) {
                const memUsage = process.memoryUsage();
                const memMB = Math.round(memUsage.heapUsed / 1024 / 1024);
                this.logger.debug(`  Memory usage: ${memMB}MB heap used`);

                // Warning if memory usage is getting high
                if (memMB > 1000) {
                    // 1GB warning
                    this.logger.warn(`⚠️  High memory usage detected: ${memMB}MB`);
                }
            }

            try {
                // Create chunks for the article
                this.logger.debug(`Creating chunks for article ${article.id}...`);
                this.logger.debug(`  Article content length: ${article.body.length} characters`);

                let chunks: ArticleChunk[];
                try {
                    // Add timeout for chunking operation
                    const chunkingPromise = new Promise<ArticleChunk[]>((resolve, reject) => {
                        try {
                            const result = this.chunkArticle(article, chunkingOptions);
                            resolve(result);
                        } catch (error) {
                            reject(error);
                        }
                    });

                    const timeoutPromise = new Promise<never>((_, reject) => {
                        setTimeout(() => reject(new Error('Chunking operation timed out after 30 seconds')), 30000);
                    });

                    chunks = await Promise.race([chunkingPromise, timeoutPromise]);
                    this.logger.info(`  → Created ${chunks.length} chunks`);
                } catch (chunkError) {
                    this.logger.error(`  ❌ Failed to chunk article ${article.id}: ${chunkError}`);
                    this.logger.error(`  ⚠️  Skipping article "${article.title}" due to chunking error`);
                    continue; // Skip this article and continue with the next one
                }

                allChunks.push(...chunks);

                // Create embeddings for chunks in batches
                this.logger.info(`  → Creating embeddings for ${chunks.length} chunks...`);
                let embeddings: Embedding[];
                try {
                    embeddings = await this.createEmbeddingsForChunks(chunks);
                    this.logger.debug(`  → Successfully created ${embeddings.length} embeddings`);
                } catch (embeddingError) {
                    this.logger.error(`  ❌ Failed to create embeddings for article ${article.id}: ${embeddingError}`);
                    this.logger.error(`  ⚠️  Skipping embeddings for "${article.title}" due to embedding error`);
                    continue; // Skip this article and continue with the next one
                }

                allEmbeddings.push(...embeddings);

                const articleTime = Date.now() - articleStartTime;
                this.logger.info(
                    `  → Article completed in ${Math.round(articleTime / 1000)}s (${embeddings.length} embeddings created)`,
                );

                // More frequent progress updates
                if ((i + 1) % 5 === 0 || i === articles.length - 1) {
                    const elapsed = Math.round((Date.now() - startTime) / 1000);
                    const avgTime = elapsed / (i + 1);
                    const remaining = Math.round(avgTime * (articles.length - i - 1));
                    this.logger.info(
                        `📊 Progress: ${i + 1}/${articles.length} articles (${Math.round(((i + 1) / articles.length) * 100)}%) - ${elapsed}s elapsed, ~${remaining}s remaining`,
                    );
                }
            } catch (error) {
                this.logger.error(`Failed to process article ${article.id} (${article.title}):`, error);
                // Log more detailed error information
                if (error instanceof Error) {
                    this.logger.error(`Error details: ${error.message}`);
                    if (error.message.includes('timeout')) {
                        this.logger.error(
                            'This may be due to network issues or API server overload. Consider checking your connection.',
                        );
                    }
                }
                // Continue with other articles
            }
        }

        const totalTime = Date.now() - startTime;
        this.logger.info(`✅ Article processing completed in ${Math.round(totalTime / 1000)}s`);
        this.logger.info(`📊 Final stats: ${allChunks.length} chunks, ${allEmbeddings.length} embeddings`);
        return { chunks: allChunks, embeddings: allEmbeddings };
    }

    /**
     * Create embeddings for a batch of chunks
     */
    async createEmbeddingsForChunks(chunks: ArticleChunk[]): Promise<Embedding[]> {
        const embeddings: Embedding[] = [];
        const batchSize = 5; // Process in smaller batches to manage rate limits and reduce timeout risk
        const totalBatches = Math.ceil(chunks.length / batchSize);

        this.logger.debug(`    Creating embeddings in ${totalBatches} batches of ${batchSize} chunks each`);

        for (let i = 0; i < chunks.length; i += batchSize) {
            const batch = chunks.slice(i, i + batchSize);
            const batchNum = Math.floor(i / batchSize) + 1;
            const batchStartTime = Date.now();

            this.logger.debug(`    Batch ${batchNum}/${totalBatches}: Processing ${batch.length} chunks...`);

            try {
                const batchEmbeddings = await this.createEmbeddingBatch(batch);
                embeddings.push(...batchEmbeddings);

                const batchTime = Date.now() - batchStartTime;
                this.logger.debug(
                    `    Batch ${batchNum}/${totalBatches}: Completed in ${Math.round(batchTime / 1000)}s`,
                );

                // Add delay between batches to respect rate limits
                if (i + batchSize < chunks.length) {
                    this.logger.debug('    Waiting 500ms before next batch...');
                    await this.delay(500); // Increased delay to reduce API pressure
                }
            } catch (error) {
                this.logger.error(
                    `Failed to create embeddings for batch ${batchNum}/${totalBatches} (starting at index ${i}):`,
                    error,
                );

                // Try individual chunks if batch fails
                this.logger.info(`    Retrying batch ${batchNum} as individual chunks...`);
                for (let j = 0; j < batch.length; j++) {
                    const chunk = batch[j];
                    try {
                        this.logger.debug(`      Individual chunk ${j + 1}/${batch.length}: ${chunk.id}`);
                        const embedding = await this.createEmbeddingForChunk(chunk);
                        embeddings.push(embedding);
                    } catch (chunkError) {
                        this.logger.error(`Failed to create embedding for chunk ${chunk.id}:`, chunkError);
                    }
                }
            }
        }

        return embeddings;
    }

    /**
     * Create embeddings for a batch of chunks
     */
    private async createEmbeddingBatch(chunks: ArticleChunk[]): Promise<Embedding[]> {
        this.logger.debug(`      📡 Checking rate limits for ${chunks.length} chunks...`);
        await this.enforceRateLimit(chunks.length);

        const texts = chunks.map((chunk) => `Title: ${chunk.title}\n\nContent: ${chunk.content}`);
        this.logger.debug(`      📡 Making API call to TNG Embedding Server for ${chunks.length} chunks...`);

        const response = await this.retryRequest(async () => {
            return this.callTngEmbeddingApi({
                model: this.config.embeddingModel,
                input: texts,
            });
        });

        // Record token usage for rate limiting
        if (response.usage) {
            this.rateLimitState.tokens.push({
                timestamp: Date.now(),
                count: response.usage.total_tokens,
            });
        }

        // Create embedding objects
        const embeddings: Embedding[] = response.data.map((embedding, index) => ({
            id: `${chunks[index].id}_embedding`,
            articleChunkId: chunks[index].id,
            vector: embedding.embedding,
            model: this.config.embeddingModel,
            createdAt: new Date().toISOString(),
        }));

        return embeddings;
    }

    /**
     * Create embedding for a single chunk
     */
    private async createEmbeddingForChunk(chunk: ArticleChunk): Promise<Embedding> {
        this.logger.debug('        📡 Checking rate limits for single chunk...');
        await this.enforceRateLimit(1);

        const text = `Title: ${chunk.title}\n\nContent: ${chunk.content}`;
        this.logger.debug(`        📡 Making API call for individual chunk ${chunk.id}...`);

        const response = await this.retryRequest(async () => {
            return this.callTngEmbeddingApi({
                model: this.config.embeddingModel,
                input: text,
            });
        });

        // Record token usage for rate limiting
        if (response.usage) {
            this.rateLimitState.tokens.push({
                timestamp: Date.now(),
                count: response.usage.total_tokens,
            });
        }

        return {
            id: `${chunk.id}_embedding`,
            articleChunkId: chunk.id,
            vector: response.data[0].embedding,
            model: this.config.embeddingModel,
            createdAt: new Date().toISOString(),
        };
    }

    /**
     * Create a single embedding for search queries
     */
    async createQueryEmbedding(query: string): Promise<number[]> {
        await this.enforceRateLimit(1);

        const response = await this.retryRequest(async () => {
            return this.callTngEmbeddingApi({
                model: this.config.embeddingModel,
                input: query,
            });
        });

        // Record token usage for rate limiting
        if (response.usage) {
            this.rateLimitState.tokens.push({
                timestamp: Date.now(),
                count: response.usage.total_tokens,
            });
        }

        return response.data[0].embedding;
    }

    /**
     * Call TNG Internal Embedding Server API
     */
    private async callTngEmbeddingApi(request: {
        model: string;
        input: string | string[];
    }): Promise<EmbeddingResponse> {
        // Create AbortController for timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

        try {
            const response = await fetch(`${this.config.baseUrl}/embeddings`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${this.config.apiKey}`,
                },
                body: JSON.stringify(request),
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const errorText = await response.text();
                let errorData;
                try {
                    errorData = JSON.parse(errorText);
                } catch {
                    errorData = { message: errorText };
                }

                throw new Error(`TNG Embedding API error (${response.status}): ${errorData.message || errorText}`);
            }

            const data: unknown = await response.json();

            // Check if response indicates an error
            if (data && typeof data === 'object' && 'message' in data && !('data' in data)) {
                throw new Error(`TNG Embedding API error: ${(data as { message: string }).message}`);
            }

            return data as EmbeddingResponse;
        } catch (error: unknown) {
            clearTimeout(timeoutId);
            const safeError = parseError(error);

            if (safeError.name === 'AbortError') {
                throw new Error(`TNG Embedding API request timed out after ${this.timeoutMs}ms`);
            }
            throw error;
        }
    }

    /**
     * Split an article into chunks
     */
    private chunkArticle(article: ZendeskArticle, options: ChunkingOptions): ArticleChunk[] {
        let content = article.body;
        const chunks: ArticleChunk[] = [];

        this.logger.debug(`    Chunking article: ${content.length} characters`);

        // Validate content
        if (!content || typeof content !== 'string') {
            throw new Error(`Invalid article content: ${typeof content}`);
        }

        if (content.length === 0) {
            this.logger.warn(`    Article ${article.id} has empty content, creating empty chunk`);
            chunks.push({
                id: `article_${article.id}_chunk_0`,
                articleId: article.id,
                title: article.title,
                content: '',
                chunkIndex: 0,
                totalChunks: 1,
                url: article.html_url,
                createdAt: article.created_at,
                updatedAt: article.updated_at,
            });
            return chunks;
        }

        // Safety check for extremely large content that could cause memory issues
        const maxContentLength = 10 * 1024 * 1024; // 10MB limit
        if (content.length > maxContentLength) {
            this.logger.warn(
                `    Article ${article.id} content is very large (${content.length} chars), truncating to ${maxContentLength}`,
            );
            content = `${content.substring(0, maxContentLength)}\n\n[Content truncated due to size]`;
        }

        if (content.length <= options.size) {
            // Article is small enough to be a single chunk
            this.logger.debug(`    Article fits in single chunk (${content.length} <= ${options.size})`);
            chunks.push({
                id: `article_${article.id}_chunk_0`,
                articleId: article.id,
                title: article.title,
                content: content.trim(),
                chunkIndex: 0,
                totalChunks: 1,
                url: article.html_url,
                createdAt: article.created_at,
                updatedAt: article.updated_at,
            });
            return chunks;
        }

        // Split into multiple chunks
        this.logger.debug(`    Article needs splitting (${content.length} > ${options.size})`);

        let chunkTexts: string[];
        try {
            chunkTexts = this.splitText(content, options);
            this.logger.debug(`    Split into ${chunkTexts.length} chunks`);
        } catch (splitError) {
            this.logger.error(`    Failed to split text for article ${article.id}: ${splitError}`);
            throw new Error(`Text splitting failed: ${splitError}`);
        }

        chunkTexts.forEach((chunkText, index) => {
            chunks.push({
                id: `article_${article.id}_chunk_${index}`,
                articleId: article.id,
                title: article.title,
                content: chunkText.trim(),
                chunkIndex: index,
                totalChunks: chunkTexts.length,
                url: article.html_url,
                createdAt: article.created_at,
                updatedAt: article.updated_at,
            });
        });

        return chunks;
    }

    /**
     * Split text into chunks with overlap
     */
    private splitText(text: string, options: ChunkingOptions): string[] {
        const chunks: string[] = [];
        let start = 0;
        let iterations = 0;
        const maxIterations = Math.ceil(text.length / Math.max(1, options.size - options.overlap)) + 100; // Safety margin

        // Validate input to prevent infinite loops
        if (options.size <= 0) {
            throw new Error(`Invalid chunk size: ${options.size}`);
        }
        if (options.overlap < 0 || options.overlap >= options.size) {
            throw new Error(`Invalid overlap: ${options.overlap} (must be 0 <= overlap < size)`);
        }

        this.logger.debug(`    Splitting text of ${text.length} chars with max ${maxIterations} iterations`);

        while (start < text.length && iterations < maxIterations) {
            iterations++;

            // Log progress for very large texts
            if (iterations % 100 === 0) {
                this.logger.debug(
                    `    Split iteration ${iterations}/${maxIterations}, position ${start}/${text.length}`,
                );
            }

            let end = start + options.size;

            // If we're not at the end of the text, try to break at word or sentence boundaries
            if (end < text.length) {
                if (options.preserveSentences) {
                    // Try to end at sentence boundary
                    const sentenceEnd = this.findSentenceEnd(text, end, start);
                    if (sentenceEnd > start) {
                        end = sentenceEnd;
                    }
                } else if (options.preserveWords) {
                    // Try to end at word boundary
                    const wordEnd = this.findWordEnd(text, end, start);
                    if (wordEnd > start) {
                        end = wordEnd;
                    }
                }
            }

            const chunk = text.slice(start, end);
            if (chunk.trim().length > 0) {
                chunks.push(chunk);
            }

            // Move start position with overlap
            const newStart = end - options.overlap;

            // Prevent infinite loops - ensure we always make progress
            if (newStart <= start) {
                this.logger.warn(`    Forcing progress: newStart ${newStart} <= start ${start}, jumping ahead`);
                start = start + Math.max(1, Math.floor(options.size / 2)); // Jump ahead by half chunk size
            } else {
                start = newStart;
            }

            // Safety check: if we've gone past the text, break
            if (start >= text.length) {
                break;
            }
        }

        if (iterations >= maxIterations) {
            this.logger.error(`    Text splitting hit maximum iterations (${maxIterations}), may be incomplete`);
            throw new Error(`Text splitting exceeded maximum iterations (${maxIterations}) - possible infinite loop`);
        }

        this.logger.debug(`    Split completed in ${iterations} iterations, created ${chunks.length} chunks`);
        return chunks.filter((chunk) => chunk.trim().length > 0);
    }

    /**
     * Find the end of a sentence near the target position
     */
    private findSentenceEnd(text: string, targetPos: number, minPos: number): number {
        const sentenceEnders = /[.!?]\s/g;
        let match;
        let lastEnd = -1;

        sentenceEnders.lastIndex = minPos;

        while ((match = sentenceEnders.exec(text)) !== null) {
            if (match.index > targetPos) {
                break;
            }
            lastEnd = match.index + 1;
        }

        return lastEnd > minPos ? lastEnd : targetPos;
    }

    /**
     * Find the end of a word near the target position
     */
    private findWordEnd(text: string, targetPos: number, minPos: number): number {
        // Look backwards from targetPos to find last word boundary
        for (let i = targetPos; i > minPos; i--) {
            if (/\s/.test(text[i])) {
                return i;
            }
        }
        return targetPos;
    }

    /**
     * Enforce rate limiting for TNG Embedding Server API calls
     */
    private async enforceRateLimit(requests: number): Promise<void> {
        const now = Date.now();
        const oneMinuteAgo = now - 60 * 1000;

        // Clean old requests and tokens
        this.rateLimitState.requests = this.rateLimitState.requests.filter((req) => req.timestamp > oneMinuteAgo);
        this.rateLimitState.tokens = this.rateLimitState.tokens.filter((token) => token.timestamp > oneMinuteAgo);

        // Check request rate limit (conservative estimate for TNG server)
        const recentRequests = this.rateLimitState.requests.length;
        const requestLimit = 100; // Conservative estimate, adjust based on actual TNG server limits

        if (recentRequests + requests > requestLimit) {
            const waitTime = Math.min(
                10 * 1000,
                60 * 1000 - (now - Math.min(...this.rateLimitState.requests.map((r) => r.timestamp))),
            );
            this.logger.warn(
                `🚦 Request rate limit reached (${recentRequests}/${requestLimit}). Waiting ${Math.round(waitTime / 1000)}s...`,
            );
            await this.delay(waitTime);
            this.logger.info('✅ Rate limit wait complete, resuming processing...');
        }

        // Check token rate limit (conservative estimate for TNG server)
        const recentTokens = this.rateLimitState.tokens.reduce((sum, token) => sum + token.count, 0);
        const tokenLimit = 50000; // Conservative estimate, adjust based on actual TNG server limits
        const estimatedTokens = requests * 100; // Rough estimate

        if (recentTokens + estimatedTokens > tokenLimit) {
            const waitTime = Math.min(
                15 * 1000,
                60 * 1000 - (now - Math.min(...this.rateLimitState.tokens.map((t) => t.timestamp))),
            );
            this.logger.warn(
                `🚦 Token rate limit reached (${recentTokens}/${tokenLimit}). Waiting ${Math.round(waitTime / 1000)}s...`,
            );
            await this.delay(waitTime);
            this.logger.info('✅ Token rate limit wait complete, resuming processing...');
        }

        // Record this request
        this.rateLimitState.requests.push({
            timestamp: now,
            endpoint: 'embeddings',
        });
    }

    /**
     * Retry a request with exponential backoff
     */
    private async retryRequest<T>(operation: () => Promise<T>): Promise<T> {
        let lastError: SafeError | undefined;

        for (let attempt = 0; attempt <= this.retryOptions.maxRetries; attempt++) {
            try {
                return await operation();
            } catch (error: unknown) {
                lastError = parseError(error);

                if (attempt === this.retryOptions.maxRetries) {
                    break;
                }

                // Don't retry client errors except rate limits
                const retryError = parseError(error);
                if (
                    retryError.status &&
                    retryError.status >= 400 &&
                    retryError.status < 500 &&
                    retryError.status !== 429
                ) {
                    break;
                }

                // Calculate delay with exponential backoff
                const delay = Math.min(
                    this.retryOptions.baseDelay * Math.pow(this.retryOptions.backoffFactor, attempt),
                    this.retryOptions.maxDelay,
                );

                this.logger.debug(`Request failed (attempt ${attempt + 1}), retrying in ${delay}ms...`);
                await this.delay(delay);
            }
        }

        throw lastError;
    }

    /**
     * Simple delay utility
     */
    private delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
