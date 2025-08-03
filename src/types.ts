/**
 * Core TypeScript interfaces and types for the RAG Zendesk CLI application
 */

import { z } from 'zod';

// Error handling schemas
export const unknownErrorSchema = z.unknown();
export const errorObjectSchema = z
    .object({
        message: z.string(),
        name: z.string().optional(),
        stack: z.string().optional(),
        code: z.string().optional(),
        status: z.number().optional(),
    })
    .passthrough();

export type SafeError = z.infer<typeof errorObjectSchema>;

// Zendesk Article schema
export const zendeskArticleSchema = z
    .object({
        id: z.number(),
        title: z.string(),
        body: z.string(),
        html_url: z.string(),
        created_at: z.string(),
        updated_at: z.string(),
        author_id: z.number(),
        comments_disabled: z.boolean(),
        draft: z.boolean(),
        promoted: z.boolean(),
        position: z.number(),
        vote_sum: z.number(),
        vote_count: z.number(),
    })
    .passthrough(); // Allow additional fields from Zendesk

// Zendesk API response schemas for different endpoint types
export const articleListResponseSchema = z
    .object({
        articles: z.array(zendeskArticleSchema),
        next_page: z.string().nullable().optional(),
        previous_page: z.string().nullable().optional(),
        count: z.number().optional(),
        page_count: z.number().optional(),
        page: z.number().optional(),
        per_page: z.number().optional(),
    })
    .passthrough();

export const articleDetailResponseSchema = z
    .object({
        article: zendeskArticleSchema,
    })
    .passthrough();

// Generic response schema for endpoints we don't need to parse specifically
export const genericApiResponseSchema = z.unknown();

export type ZendeskArticle = z.infer<typeof zendeskArticleSchema>;
export type ArticleListResponse = z.infer<typeof articleListResponseSchema>;
export type ArticleDetailResponse = z.infer<typeof articleDetailResponseSchema>;

// Helper function to safely parse errors
export function parseError(error: unknown): SafeError {
    const result = errorObjectSchema.safeParse(error);
    if (result.success) {
        return result.data;
    }

    // Fallback for any unexpected error types
    return {
        message: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : 'UnknownError',
        stack: error instanceof Error ? error.stack : undefined,
    };
}

export interface ZendeskApiResponseGeneric<T> {
    count: number;
    next_page: string | null;
    previous_page: string | null;
    page_count: number;
    page: number;
    per_page: number;
    [key: string]: T[] | number | string | null;
}

export interface ArticleChunk {
    id: string;
    articleId: number;
    title: string;
    content: string;
    chunkIndex: number;
    totalChunks: number;
    url: string;
    createdAt: string;
    updatedAt: string;
}

export interface Embedding {
    id: string;
    articleChunkId: string;
    vector: number[];
    model: string;
    createdAt: string;
}

export interface VectorSearchResult {
    chunk: ArticleChunk;
    embedding: Embedding;
    similarity: number;
    score: number;
}

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
    timestamp?: string;
    sources?: SourceReference[];
}

export interface SourceReference {
    articleId: number;
    title: string;
    url: string;
    snippet: string;
    relevanceScore: number;
}

export interface ChatSession {
    id: string;
    messages: ChatMessage[];
    createdAt: string;
    updatedAt: string;
}

export interface VectorStore {
    articles: Record<number, ZendeskArticle>;
    chunks: Record<string, ArticleChunk>;
    embeddings: Record<string, Embedding>;
    metadata: {
        version: string;
        createdAt: string;
        updatedAt: string;
        totalArticles: number;
        totalChunks: number;
        embeddingModel: string;
        chunkSize: number;
        chunkOverlap: number;
    };
}

export interface AppConfig {
    tngEmbedding: {
        apiKey: string;
        baseUrl: string;
        embeddingModel: string;
    };
    openai: {
        apiKey: string;
        baseUrl: string;
        chatModel: string;
        maxTokens: number;
        temperature: number;
    };
    zendesk: {
        subdomain: string;
        email: string;
        apiToken: string;
        oauthToken: string;
    };
    chunking: {
        size: number;
        overlap: number;
        preserveWords: boolean;
        preserveSentences: boolean;
    };
    vectorStore: {
        filePath: string;
    };
    chat: {
        historyPath: string;
        maxContextMessages: number;
        maxSourceResults: number;
        minSimilarity: number;
    };
    rateLimit: {
        zendesk: {
            requestsPerMinute: number;
            requestsPerHour: number;
        };
        tngEmbedding: {
            requestsPerMinute: number;
            tokensPerMinute: number;
        };
        openai: {
            requestsPerMinute: number;
            tokensPerMinute: number;
        };
    };
    timeouts: {
        apiRequestMs: number;
    };
    logLevel: LogLevel;
    excludedArticleIds: string[];
}

export interface RateLimitState {
    requests: Array<{ timestamp: number; endpoint: string }>;
    tokens: Array<{ timestamp: number; count: number }>;
}

export interface EmbeddingRequest {
    text: string;
    model?: string;
}

export interface EmbeddingResponse {
    object: string;
    data: Array<{
        object: string;
        embedding: number[];
        index: number;
    }>;
    model: string;
    usage: {
        prompt_tokens: number;
        total_tokens: number;
    };
}

export interface ChatCompletionRequest {
    model: string;
    messages: ChatMessage[];
    temperature?: number;
    max_tokens?: number;
    top_p?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
    stream?: boolean;
}

export interface ChatCompletionResponse {
    id: string;
    object: string;
    created: number;
    model: string;
    choices: Array<{
        index: number;
        message: ChatMessage;
        finish_reason: string;
    }>;
    usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}

export interface ApiError {
    message: string;
    type: string;
    code?: string | undefined;
    status?: number | undefined;
    details?: unknown;
}

export interface RetryOptions {
    maxRetries: number;
    baseDelay: number;
    maxDelay: number;
    backoffFactor: number;
}

export interface ChunkingOptions {
    size: number;
    overlap: number;
    preserveWords: boolean;
    preserveSentences: boolean;
}

export interface SearchOptions {
    maxResults: number;
    minSimilarity: number;
    includeMetadata: boolean;
    boostRecent: boolean;
    recentBoostFactor: number;
}

export interface CliCommand {
    name: string;
    description: string;
    handler: () => Promise<void>;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
    debug(message: string, ...args: unknown[]): void;
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
}
