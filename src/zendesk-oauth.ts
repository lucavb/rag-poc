/**
 * Zendesk OAuth client for use with OAuth tokens
 */

import * as cheerio from 'cheerio';
import type { ZendeskArticle, RateLimitState, RetryOptions, Logger, SafeError } from './types.ts';
import { parseError, articleListResponseSchema, articleDetailResponseSchema } from './types.ts';
import { z } from 'zod';

export interface ZendeskOAuthConfig {
    subdomain: string;
    accessToken: string;
}

export class ZendeskOAuthClient {
    private baseURL: string;
    private defaultHeaders: Record<string, string>;
    private timeoutMs: number;
    private rateLimitState: RateLimitState;
    private retryOptions: RetryOptions;
    private logger: Logger;

    constructor(config: ZendeskOAuthConfig, timeoutMs: number, logger: Logger) {
        this.logger = logger;
        this.timeoutMs = timeoutMs;
        this.baseURL = `https://${config.subdomain}.zendesk.com/api/v2`;

        this.defaultHeaders = {
            Authorization: `Bearer ${config.accessToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
        };

        // Initialize rate limit state
        this.rateLimitState = {
            requests: [],
            tokens: [],
        };

        // Retry configuration
        this.retryOptions = {
            maxRetries: 3,
            baseDelay: 1000,
            maxDelay: 10000,
            backoffFactor: 2,
        };
    }

    /**
     * Fetch all published articles from Zendesk Help Center
     */
    async fetchAllArticles(): Promise<ZendeskArticle[]> {
        this.logger.info('Starting to fetch all Zendesk articles using OAuth...');

        const articles: ZendeskArticle[] = [];
        let page = 1;
        let hasMore = true;

        while (hasMore) {
            try {
                this.logger.info(`📖 Fetching articles page ${page} (OAuth)...`);

                const response = await this.retryRequest(async () => {
                    const params = new URLSearchParams({
                        per_page: '100',
                        page: page.toString(),
                        sort_by: 'updated_at',
                        sort_order: 'desc',
                    });

                    return this.makeRequestWithSchema(`/help_center/articles?${params}`, articleListResponseSchema);
                });

                const pageArticles = response.articles;

                if (pageArticles && pageArticles.length > 0) {
                    // Filter for published articles only
                    const publishedArticles = pageArticles.filter((article) => !article.draft);
                    articles.push(...publishedArticles);

                    this.logger.info(
                        `✅ Page ${page}: Found ${publishedArticles.length} published articles (${pageArticles.length - publishedArticles.length} drafts skipped)`,
                    );
                    this.logger.debug(`   Total so far: ${articles.length} articles`);
                }

                hasMore = response.next_page !== null;
                page++;

                // Add a small delay between pages
                if (hasMore) {
                    this.logger.debug('   Waiting 200ms before next page...');
                    await this.delay(200);
                }
            } catch (error) {
                this.logger.error(`Failed to fetch articles page ${page}:`, error);
                throw error;
            }
        }

        this.logger.info(`Successfully fetched ${articles.length} total published articles`);
        return articles;
    }

    /**
     * Fetch a specific article by ID
     */
    async fetchArticle(articleId: number): Promise<ZendeskArticle | null> {
        try {
            this.logger.debug(`Fetching article ${articleId}...`);

            const response = await this.retryRequest(async () => {
                return this.makeRequestWithSchema(`/help_center/articles/${articleId}`, articleDetailResponseSchema);
            });

            return response.article;
        } catch (error: unknown) {
            const safeError = parseError(error);
            if (safeError.status === 404) {
                this.logger.warn(`Article ${articleId} not found`);
                return null;
            }
            throw error;
        }
    }

    /**
     * Convert HTML content to plain text
     */
    htmlToText(html: string): string {
        const $ = cheerio.load(html);

        // Remove script and style elements
        $('script, style, noscript').remove();

        // Convert line breaks and paragraphs to newlines
        $('br').replaceWith('\n');
        $('p, div, h1, h2, h3, h4, h5, h6').each((_, elem) => {
            $(elem).append('\n');
        });

        // Convert lists to formatted text
        $('li').each((_, elem) => {
            $(elem).prepend('• ').append('\n');
        });

        // Get text content and clean it up
        let text = $.text();

        // Normalize whitespace
        text = text.replace(/\r\n/g, '\n');
        text = text.replace(/\r/g, '\n');
        text = text.replace(/\n\s*\n\s*\n/g, '\n\n'); // Multiple newlines to double
        text = text.replace(/[ \t]+/g, ' '); // Multiple spaces to single
        text = text.trim();

        return text;
    }

    /**
     * Test OAuth connection
     */
    async testConnection(): Promise<boolean> {
        try {
            this.logger.info('Testing Zendesk OAuth API connection...');

            // Simple GET request to test connection - we don't need to parse the response
            const url = `${this.baseURL}/help_center/articles?per_page=1`;
            const response = await fetch(url, {
                headers: this.defaultHeaders,
                signal: AbortSignal.timeout(this.timeoutMs),
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            this.logger.info('Zendesk OAuth API connection successful');
            return true;
        } catch (error: unknown) {
            const safeError = parseError(error);
            this.logger.error('Zendesk OAuth API connection failed:', safeError.message);
            return false;
        }
    }

    /**
     * Make a request to the Zendesk API with schema validation
     */
    private async makeRequestWithSchema<T>(endpoint: string, schema: z.ZodSchema<T>): Promise<T> {
        await this.enforceRateLimit();

        const url = `${this.baseURL}${endpoint}`;

        // Create AbortController for timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

        try {
            const response = await fetch(url, {
                headers: this.defaultHeaders,
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const errorText = await response.text();
                let errorData: { error?: string } = {};

                try {
                    errorData = JSON.parse(errorText);
                } catch {
                    errorData = { error: errorText };
                }

                throw new Error(`Zendesk OAuth API error (${response.status}): ${errorData.error || errorText}`);
            }

            const data: unknown = await response.json();
            const parseResult = schema.safeParse(data);

            if (!parseResult.success) {
                this.logger.warn('API response does not match expected schema:', {
                    url,
                    issues: parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
                });
                throw new Error(`Invalid API response format: ${parseResult.error.issues[0]?.message}`);
            }

            return parseResult.data;
        } catch (error: unknown) {
            clearTimeout(timeoutId);

            const safeError = parseError(error);
            if (safeError.name === 'AbortError') {
                throw new Error(`Zendesk OAuth API request timed out after ${this.timeoutMs}ms`);
            }
            throw error;
        }
    }

    private async enforceRateLimit(): Promise<void> {
        const now = Date.now();
        const oneMinuteAgo = now - 60 * 1000;
        const oneHourAgo = now - 60 * 60 * 1000;

        this.rateLimitState.requests = this.rateLimitState.requests.filter((req) => req.timestamp > oneHourAgo);

        const recentRequests = this.rateLimitState.requests.filter((req) => req.timestamp > oneMinuteAgo);

        const requestsPerMinute = 200;
        const requestsPerHour = 700;

        if (recentRequests.length >= requestsPerMinute) {
            const oldestRecentRequest = Math.min(...recentRequests.map((r) => r.timestamp));
            const waitTime = 60 * 1000 - (now - oldestRecentRequest);

            if (waitTime > 0) {
                this.logger.debug(`Rate limit reached, waiting ${waitTime}ms...`);
                await this.delay(waitTime);
            }
        }

        if (this.rateLimitState.requests.length >= requestsPerHour) {
            const oldestRequest = Math.min(...this.rateLimitState.requests.map((r) => r.timestamp));
            const waitTime = 60 * 60 * 1000 - (now - oldestRequest);

            if (waitTime > 0) {
                this.logger.debug(`Hourly rate limit reached, waiting ${waitTime}ms...`);
                await this.delay(waitTime);
            }
        }

        this.rateLimitState.requests.push({
            timestamp: now,
            endpoint: 'zendesk',
        });
    }

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

                // Don't retry client errors (4xx) except rate limits
                const retryError = parseError(error);
                const status = retryError.status;
                if (status && status >= 400 && status < 500 && status !== 429) {
                    break;
                }

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

    private delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
