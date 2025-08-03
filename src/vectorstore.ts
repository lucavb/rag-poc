/**
 * File-based vector store with cosine similarity search
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type {
    VectorStore,
    ArticleChunk,
    Embedding,
    ZendeskArticle,
    VectorSearchResult,
    SearchOptions,
    Logger,
} from './types.ts';

export class VectorStoreService {
    private vectorStore: VectorStore;
    private filePath: string;
    private logger: Logger;
    private isLoaded: boolean = false;

    constructor(filePath: string, logger: Logger) {
        this.filePath = filePath;
        this.logger = logger;
        this.vectorStore = this.createEmptyStore();
    }

    /**
     * Load vector store from file or create empty one
     */
    async load(): Promise<void> {
        try {
            const exists = await this.fileExists(this.filePath);

            if (exists) {
                this.logger.info(`Loading vector store from ${this.filePath}...`);
                const data = await fs.readFile(this.filePath, 'utf-8');
                this.vectorStore = JSON.parse(data);

                this.logger.info(
                    `Loaded vector store with ${this.vectorStore.metadata.totalArticles} articles, ` +
                        `${this.vectorStore.metadata.totalChunks} chunks, and ${Object.keys(this.vectorStore.embeddings).length} embeddings`,
                );
            } else {
                this.logger.info('No existing vector store found, creating new one');
                this.vectorStore = this.createEmptyStore();
            }

            this.isLoaded = true;
        } catch (error) {
            this.logger.error('Failed to load vector store:', error);
            this.logger.info('Creating new empty vector store');
            this.vectorStore = this.createEmptyStore();
            this.isLoaded = true;
        }
    }

    /**
     * Save vector store to file
     */
    async save(): Promise<void> {
        if (!this.isLoaded) {
            throw new Error('Vector store not loaded');
        }

        try {
            // Ensure directory exists
            const dir = path.dirname(this.filePath);
            await fs.mkdir(dir, { recursive: true });

            // Update metadata
            this.vectorStore.metadata.updatedAt = new Date().toISOString();
            this.vectorStore.metadata.totalArticles = Object.keys(this.vectorStore.articles).length;
            this.vectorStore.metadata.totalChunks = Object.keys(this.vectorStore.chunks).length;

            // Write to file
            const data = JSON.stringify(this.vectorStore, null, 2);
            await fs.writeFile(this.filePath, data, 'utf-8');

            this.logger.info(`Saved vector store to ${this.filePath}`);
        } catch (error) {
            this.logger.error('Failed to save vector store:', error);
            throw error;
        }
    }

    /**
     * Add or update articles, chunks, and embeddings
     */
    async upsertData(
        articles: ZendeskArticle[],
        chunks: ArticleChunk[],
        embeddings: Embedding[],
        embeddingModel: string,
        chunkSize: number,
        chunkOverlap: number,
    ): Promise<void> {
        if (!this.isLoaded) {
            await this.load();
        }

        this.logger.info(
            `Upserting ${articles.length} articles, ${chunks.length} chunks, and ${embeddings.length} embeddings...`,
        );

        // Add articles
        for (const article of articles) {
            this.vectorStore.articles[article.id] = article;
        }

        // Add chunks
        for (const chunk of chunks) {
            this.vectorStore.chunks[chunk.id] = chunk;
        }

        // Add embeddings
        for (const embedding of embeddings) {
            this.vectorStore.embeddings[embedding.id] = embedding;
        }

        // Update metadata
        this.vectorStore.metadata.embeddingModel = embeddingModel;
        this.vectorStore.metadata.chunkSize = chunkSize;
        this.vectorStore.metadata.chunkOverlap = chunkOverlap;

        await this.save();
    }

    /**
     * Search for similar chunks using cosine similarity
     */
    async search(
        queryEmbedding: number[],
        options: SearchOptions = {
            maxResults: 5,
            minSimilarity: 0.7,
            includeMetadata: true,
            boostRecent: false,
            recentBoostFactor: 1.1,
        },
    ): Promise<VectorSearchResult[]> {
        if (!this.isLoaded) {
            await this.load();
        }

        const results: VectorSearchResult[] = [];
        const embeddings = Object.values(this.vectorStore.embeddings);

        this.logger.debug(`Searching through ${embeddings.length} embeddings...`);
        this.logger.debug(
            `Query embedding dimensions: ${queryEmbedding.length}, first 3 values: [${queryEmbedding.slice(0, 3).join(', ')}]`,
        );

        let maxSimilarity = -1;
        let minSimilarity = 1;
        let sampleCount = 0;

        for (const embedding of embeddings) {
            const similarity = this.cosineSimilarity(queryEmbedding, embedding.vector);

            // Track similarity score ranges for debugging
            maxSimilarity = Math.max(maxSimilarity, similarity);
            minSimilarity = Math.min(minSimilarity, similarity);

            // Log first few for debugging
            if (sampleCount < 3) {
                this.logger.debug(
                    `Sample embedding ${sampleCount}: dims=${embedding.vector.length}, similarity=${similarity.toFixed(4)}, first 3 values: [${embedding.vector.slice(0, 3).join(', ')}]`,
                );
                sampleCount++;
            }

            if (similarity >= options.minSimilarity) {
                const chunk = this.vectorStore.chunks[embedding.articleChunkId];

                if (chunk) {
                    let score = similarity;

                    // Apply recency boost if enabled
                    if (options.boostRecent) {
                        const articleAge = this.getArticleAgeInDays(chunk.updatedAt);
                        const boostFactor = Math.max(1, options.recentBoostFactor - articleAge / 365);
                        score *= boostFactor;
                    }

                    results.push({
                        chunk,
                        embedding,
                        similarity,
                        score,
                    });
                }
            }
        }

        // Sort by score (highest first) and limit results
        results.sort((a, b) => b.score - a.score);
        const limitedResults = results.slice(0, options.maxResults);

        this.logger.debug(
            `Similarity scores - Min: ${minSimilarity.toFixed(4)}, Max: ${maxSimilarity.toFixed(4)}, Threshold: ${options.minSimilarity}`,
        );
        this.logger.debug(`Found ${limitedResults.length} relevant chunks`);

        return limitedResults;
    }

    /**
     * Get article by ID
     */
    getArticle(articleId: number): ZendeskArticle | null {
        if (!this.isLoaded) {
            throw new Error('Vector store not loaded');
        }

        return this.vectorStore.articles[articleId] || null;
    }

    /**
     * Get chunk by ID
     */
    getChunk(chunkId: string): ArticleChunk | null {
        if (!this.isLoaded) {
            throw new Error('Vector store not loaded');
        }

        return this.vectorStore.chunks[chunkId] || null;
    }

    /**
     * Get chunks for an article
     */
    getArticleChunks(articleId: number): ArticleChunk[] {
        if (!this.isLoaded) {
            throw new Error('Vector store not loaded');
        }

        return Object.values(this.vectorStore.chunks).filter((chunk) => chunk.articleId === articleId);
    }

    /**
     * Get store statistics
     */
    getStats(): {
        totalArticles: number;
        totalChunks: number;
        totalEmbeddings: number;
        embeddingModel: string;
        lastUpdated: string;
    } {
        if (!this.isLoaded) {
            throw new Error('Vector store not loaded');
        }

        return {
            totalArticles: Object.keys(this.vectorStore.articles).length,
            totalChunks: Object.keys(this.vectorStore.chunks).length,
            totalEmbeddings: Object.keys(this.vectorStore.embeddings).length,
            embeddingModel: this.vectorStore.metadata.embeddingModel,
            lastUpdated: this.vectorStore.metadata.updatedAt,
        };
    }

    /**
     * Clear all data from the store
     */
    async clear(): Promise<void> {
        this.logger.info('Clearing vector store...');
        this.vectorStore = this.createEmptyStore();
        await this.save();
    }

    /**
     * Check if an article exists in the store
     */
    hasArticle(articleId: number): boolean {
        if (!this.isLoaded) {
            return false;
        }

        return articleId in this.vectorStore.articles;
    }

    /**
     * Check if store needs reindexing based on article updates
     */
    needsReindexing(articles: ZendeskArticle[]): {
        needsReindex: boolean;
        newArticles: ZendeskArticle[];
        updatedArticles: ZendeskArticle[];
        deletedArticleIds: number[];
    } {
        if (!this.isLoaded) {
            return {
                needsReindex: true,
                newArticles: articles,
                updatedArticles: [],
                deletedArticleIds: [],
            };
        }

        const existingArticles = this.vectorStore.articles;
        const newArticles: ZendeskArticle[] = [];
        const updatedArticles: ZendeskArticle[] = [];
        const currentArticleIds = new Set(articles.map((a) => a.id));
        const existingArticleIds = new Set(Object.keys(existingArticles).map(Number));

        // Find new and updated articles
        for (const article of articles) {
            const existing = existingArticles[article.id];

            if (!existing) {
                newArticles.push(article);
            } else if (new Date(article.updated_at) > new Date(existing.updated_at)) {
                updatedArticles.push(article);
            }
        }

        // Find deleted articles
        const deletedArticleIds = Array.from(existingArticleIds).filter((id) => !currentArticleIds.has(id));

        const needsReindex = newArticles.length > 0 || updatedArticles.length > 0 || deletedArticleIds.length > 0;

        return {
            needsReindex,
            newArticles,
            updatedArticles,
            deletedArticleIds,
        };
    }

    /**
     * Remove articles and their associated chunks/embeddings
     */
    async removeArticles(articleIds: number[]): Promise<void> {
        if (!this.isLoaded) {
            await this.load();
        }

        this.logger.info(`Removing ${articleIds.length} articles...`);

        for (const articleId of articleIds) {
            // Remove article
            delete this.vectorStore.articles[articleId];

            // Remove associated chunks and embeddings
            const chunksToRemove = Object.values(this.vectorStore.chunks).filter(
                (chunk) => chunk.articleId === articleId,
            );

            for (const chunk of chunksToRemove) {
                delete this.vectorStore.chunks[chunk.id];

                // Remove associated embedding
                const embeddingId = `${chunk.id}_embedding`;
                delete this.vectorStore.embeddings[embeddingId];
            }
        }

        await this.save();
    }

    /**
     * Calculate cosine similarity between two vectors
     */
    private cosineSimilarity(vectorA: number[], vectorB: number[]): number {
        if (vectorA.length !== vectorB.length) {
            throw new Error('Vectors must have the same length');
        }

        let dotProduct = 0;
        let normA = 0;
        let normB = 0;

        for (let i = 0; i < vectorA.length; i++) {
            dotProduct += vectorA[i] * vectorB[i];
            normA += vectorA[i] * vectorA[i];
            normB += vectorB[i] * vectorB[i];
        }

        const magnitude = Math.sqrt(normA) * Math.sqrt(normB);

        if (magnitude === 0) {
            return 0;
        }

        return dotProduct / magnitude;
    }

    /**
     * Get article age in days
     */
    private getArticleAgeInDays(updatedAt: string): number {
        const now = new Date();
        const articleDate = new Date(updatedAt);
        const diffTime = Math.abs(now.getTime() - articleDate.getTime());
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        return diffDays;
    }

    /**
     * Create empty vector store structure
     */
    private createEmptyStore(): VectorStore {
        return {
            articles: {},
            chunks: {},
            embeddings: {},
            metadata: {
                version: '1.0.0',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                totalArticles: 0,
                totalChunks: 0,
                embeddingModel: '',
                chunkSize: 1000,
                chunkOverlap: 200,
            },
        };
    }

    /**
     * Check if file exists
     */
    private async fileExists(filePath: string): Promise<boolean> {
        try {
            await fs.access(filePath);
            return true;
        } catch {
            return false;
        }
    }
}
