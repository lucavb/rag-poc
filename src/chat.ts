/**
 * Chat service with history management and context-aware responses
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import OpenAI from 'openai';
import type {
    AppConfig,
    ChatMessage,
    ChatSession,
    VectorSearchResult,
    SourceReference,
    Logger,
    RateLimitState,
    SafeError,
    RetryOptions,
} from './types.ts';
import { parseError } from './types.ts';

export class ChatService {
    private client: OpenAI;
    private config: AppConfig;
    private currentSession: ChatSession | null = null;
    private historyPath: string;
    private rateLimitState: RateLimitState;
    private retryOptions: RetryOptions;
    private logger: Logger;

    constructor(config: AppConfig, logger: Logger) {
        this.config = config;
        this.logger = logger;
        this.historyPath = config.chat.historyPath;

        // Initialize OpenAI client
        this.client = new OpenAI({
            apiKey: config.openai.apiKey,
            baseURL: config.openai.baseUrl,
        });

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
     * Start a new chat session
     */
    async startNewSession(): Promise<void> {
        this.currentSession = {
            id: this.generateSessionId(),
            messages: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };

        // Add system message
        const systemMessage: ChatMessage = {
            role: 'system',
            content: this.getSystemPrompt(),
            timestamp: new Date().toISOString(),
        };

        this.currentSession.messages.push(systemMessage);
        this.logger.info(`Started new chat session: ${this.currentSession.id}`);
    }

    /**
     * Load existing session or create new one
     */
    async loadOrCreateSession(): Promise<void> {
        try {
            const exists = await this.fileExists(this.historyPath);

            if (exists) {
                this.logger.debug('Loading existing chat session...');
                const data = await fs.readFile(this.historyPath, 'utf-8');
                this.currentSession = JSON.parse(data);

                if (this.currentSession?.messages) {
                    this.logger.info(`Loaded chat session with ${this.currentSession.messages.length} messages`);
                } else {
                    this.logger.warn('Loaded session has invalid format, starting new session');
                    await this.startNewSession();
                }
            } else {
                await this.startNewSession();
            }
        } catch (error) {
            this.logger.warn('Failed to load chat session, starting new one:', error);
            await this.startNewSession();
        }
    }

    /**
     * Save current session to file
     */
    async saveSession(): Promise<void> {
        if (!this.currentSession) {
            return;
        }

        try {
            // Ensure directory exists
            const dir = path.dirname(this.historyPath);
            await fs.mkdir(dir, { recursive: true });

            // Update session metadata
            this.currentSession.updatedAt = new Date().toISOString();

            // Write to file
            const data = JSON.stringify(this.currentSession, null, 2);
            await fs.writeFile(this.historyPath, data, 'utf-8');

            this.logger.debug('Saved chat session');
        } catch (error) {
            this.logger.error('Failed to save chat session:', error);
        }
    }

    /**
     * Clear chat history
     */
    async clearHistory(): Promise<void> {
        this.logger.info('Clearing chat history...');
        await this.startNewSession();
        await this.saveSession();
    }

    /**
     * Generate response using context from search results
     */
    async generateResponse(
        userMessage: string,
        searchResults: VectorSearchResult[],
    ): Promise<{ response: string; sources: SourceReference[] }> {
        if (!this.currentSession) {
            await this.loadOrCreateSession();
        }

        // Add user message to history
        const userChatMessage: ChatMessage = {
            role: 'user',
            content: userMessage,
            timestamp: new Date().toISOString(),
        };

        if (!this.currentSession) {
            throw new Error('No active chat session. Please initialize session first.');
        }
        this.currentSession.messages.push(userChatMessage);

        // Prepare context from search results
        const context = this.prepareContext(searchResults);
        const sources = this.extractSources(searchResults);

        // Create enhanced user message with context
        const enhancedMessage = this.createEnhancedMessage(userMessage, context);

        // Prepare messages for API call
        const messages = this.prepareMessagesForApi(enhancedMessage);

        try {
            // Generate response
            await this.enforceRateLimit(1);

            const response = await this.retryRequest(async () => {
                return this.client.chat.completions.create({
                    model: this.config.openai.chatModel,
                    messages,
                    temperature: this.config.openai.temperature,
                    max_tokens: this.config.openai.maxTokens,
                    stream: false,
                });
            });

            // Record token usage for rate limiting
            this.rateLimitState.tokens.push({
                timestamp: Date.now(),
                count: response.usage?.total_tokens || 0,
            });

            const assistantMessage = response.choices[0].message.content || '';

            // Add assistant message to history
            const assistantChatMessage: ChatMessage = {
                role: 'assistant',
                content: assistantMessage,
                timestamp: new Date().toISOString(),
                sources,
            };

            if (!this.currentSession) {
                throw new Error('No active chat session. Session was lost during processing.');
            }
            this.currentSession.messages.push(assistantChatMessage);

            // Save session
            await this.saveSession();

            this.logger.debug(`Generated response with ${sources.length} sources`);

            return {
                response: assistantMessage,
                sources,
            };
        } catch (error) {
            this.logger.error('Failed to generate response:', error);
            throw error;
        }
    }

    /**
     * Get current session messages
     */
    getCurrentMessages(): ChatMessage[] {
        return this.currentSession?.messages || [];
    }

    /**
     * Get conversation history (excluding system messages)
     */
    getConversationHistory(): ChatMessage[] {
        if (!this.currentSession) {
            return [];
        }

        return this.currentSession.messages.filter((msg) => msg.role !== 'system');
    }

    /**
     * Prepare context string from search results
     */
    private prepareContext(searchResults: VectorSearchResult[]): string {
        if (searchResults.length === 0) {
            return 'No relevant information found in the knowledge base.';
        }

        const contextParts = searchResults.map((result, index) => {
            const { chunk } = result;
            return `[${index + 1}] From "${chunk.title}" (Article ID: ${chunk.articleId}):\n${chunk.content}\n`;
        });

        return `Relevant information from Zendesk articles:\n\n${contextParts.join('\n')}`;
    }

    /**
     * Extract source references from search results
     */
    private extractSources(searchResults: VectorSearchResult[]): SourceReference[] {
        return searchResults.map((result) => ({
            articleId: result.chunk.articleId,
            title: result.chunk.title,
            url: result.chunk.url,
            snippet: this.truncateText(result.chunk.content, 150),
            relevanceScore: result.similarity,
        }));
    }

    /**
     * Create enhanced message with context
     */
    private createEnhancedMessage(userMessage: string, context: string): string {
        return `Context from knowledge base:
${context}

User question: ${userMessage}

Please provide a helpful answer based on the context above. If the context doesn't contain relevant information, please say so clearly. Always reference the specific articles when citing information.`;
    }

    /**
     * Prepare messages for OpenAI API call
     */
    private prepareMessagesForApi(enhancedMessage: string): ChatMessage[] {
        if (!this.currentSession) {
            throw new Error('No active chat session');
        }

        const messages: ChatMessage[] = [];

        // Add system message
        const systemMessage = this.currentSession.messages.find((msg) => msg.role === 'system');
        if (systemMessage) {
            messages.push(systemMessage);
        }

        // Add recent conversation history (excluding the last user message we just added)
        const conversationHistory = this.currentSession.messages
            .filter((msg) => msg.role !== 'system')
            .slice(0, -1) // Exclude the last user message
            .slice(-this.config.chat.maxContextMessages * 2); // Keep last N exchanges

        messages.push(...conversationHistory);

        // Add the enhanced user message
        messages.push({
            role: 'user',
            content: enhancedMessage,
        });

        return messages;
    }

    /**
     * Get system prompt for the assistant
     */
    private getSystemPrompt(): string {
        return `You are a helpful AI assistant that answers questions based on Zendesk help center articles. 

Your role:
- Answer questions using only the provided context from Zendesk articles
- Be accurate and helpful
- Always cite the specific article titles and IDs when referencing information
- If the context doesn't contain relevant information, clearly state this
- Provide direct links to articles when possible
- Be concise but thorough in your responses

Guidelines:
- Use the exact information from the articles provided
- Don't make up information that's not in the context
- If multiple articles are relevant, mention them all
- Format your responses clearly with proper citations
- Be conversational but professional

Remember: Always ground your answers in the provided context and cite your sources clearly.`;
    }

    /**
     * Generate unique session ID
     */
    private generateSessionId(): string {
        const timestamp = Date.now().toString(36);
        const random = Math.random().toString(36).substr(2, 5);
        return `session_${timestamp}_${random}`;
    }

    /**
     * Truncate text to specified length
     */
    private truncateText(text: string, maxLength: number): string {
        if (text.length <= maxLength) {
            return text;
        }

        const truncated = text.substr(0, maxLength);
        const lastSpace = truncated.lastIndexOf(' ');

        return lastSpace > 0 ? `${truncated.substr(0, lastSpace)}...` : `${truncated}...`;
    }

    /**
     * Enforce rate limiting for OpenAI API calls
     */
    private async enforceRateLimit(requests: number): Promise<void> {
        const now = Date.now();
        const oneMinuteAgo = now - 60 * 1000;

        // Clean old requests and tokens
        this.rateLimitState.requests = this.rateLimitState.requests.filter((req) => req.timestamp > oneMinuteAgo);
        this.rateLimitState.tokens = this.rateLimitState.tokens.filter((token) => token.timestamp > oneMinuteAgo);

        // Check request rate limit (varies by model)
        const recentRequests = this.rateLimitState.requests.length;
        const requestLimit = this.config.openai.chatModel.includes('gpt-4') ? 10000 : 3500;

        if (recentRequests + requests > requestLimit) {
            const waitTime = 60 * 1000;
            this.logger.debug(`Request rate limit would be exceeded, waiting ${waitTime}ms...`);
            await this.delay(waitTime);
        }

        // Check token rate limit
        const recentTokens = this.rateLimitState.tokens.reduce((sum, token) => sum + token.count, 0);
        const tokenLimit = this.config.openai.chatModel.includes('gpt-4') ? 300000 : 200000;
        const estimatedTokens = requests * 1000; // Rough estimate

        if (recentTokens + estimatedTokens > tokenLimit) {
            const waitTime = 60 * 1000;
            this.logger.debug(`Token rate limit would be exceeded, waiting ${waitTime}ms...`);
            await this.delay(waitTime);
        }

        // Record this request
        this.rateLimitState.requests.push({
            timestamp: now,
            endpoint: 'chat',
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
                const safeError = parseError(error);
                if (safeError.status && safeError.status >= 400 && safeError.status < 500 && safeError.status !== 429) {
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
