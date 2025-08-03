# RAG Zendesk CLI (Proof of Concept)

A TypeScript CLI application that demonstrates Retrieval-Augmented Generation (RAG) for chatting with Zendesk Help Center articles. This **proof of concept** fetches articles from your Zendesk instance, creates embeddings using a custom TNG embedding server, and provides an interactive AI-powered chat interface to help users find information quickly.

> **⚠️ Note: This is a Proof of Concept**  
> This project is designed as a demonstration and learning tool for RAG implementation with Zendesk. It showcases the core concepts and architecture but may need additional work for production use.

## Features

- 🚀 **RAG Implementation**: Complete Retrieval-Augmented Generation pipeline
- 📚 **Zendesk Integration**: Fetch and process articles from Zendesk Help Center with OAuth support
- 🔍 **Vector Search**: Cosine similarity search using custom TNG embedding server
- 💬 **Interactive Chat**: CLI chat interface with conversation history
- 📊 **Source Attribution**: Responses include references to source articles with relevance scores
- 🔄 **Incremental Updates**: Smart reindexing for new and updated articles
- ⚡ **Rate Limiting**: Built-in rate limiting for all API calls
- 🛡️ **Error Handling**: Comprehensive error handling and retry logic with Zod validation
- 🎯 **Type Safety**: Full TypeScript implementation with strict type checking

## Requirements

- Node.js 16+
- TypeScript
- TNG Embedding Server (custom embedding service)
- OpenAI API access (for chat completions)
- Zendesk account with OAuth or API token access

## Installation

1. Clone the repository:

```bash
git clone <repository-url>
cd rag-zendesk-cli
```

2. Install dependencies:

```bash
npm install
```

3. Build the TypeScript code:

```bash
npm run build
```

4. Set up environment variables:

```bash
cp .env.example .env
# Edit .env with your configuration
```

## Environment Variables

Create a `.env` file in the project root with the following variables. All values are validated using **Zod schemas** for type safety and helpful error messages.

### Required Variables

```env
# TNG Embedding Server (Required for embeddings)
TNG_EMBEDDING_API_KEY=your_tng_embedding_api_key_here
TNG_EMBEDDING_BASE_URL=https://your-tng-embedding-server.com

# OpenAI Configuration (Required for chat)
OPENAI_API_KEY=your_openai_api_key_here

# Zendesk Configuration (Required)
ZENDESK_SUBDOMAIN=your_zendesk_subdomain

# Zendesk Authentication - Choose ONE:
# Option 1: OAuth (Recommended)
ZENDESK_OAUTH_TOKEN=your_oauth_access_token

# Option 2: API Token (Traditional)
# ZENDESK_EMAIL=your_zendesk_email@example.com
# ZENDESK_API_TOKEN=your_zendesk_api_token
```

### Optional Variables (with defaults)

```env
# TNG Embedding Settings
EMBEDDING_MODEL=BAAI/bge-large-en-v1.5

# OpenAI Settings
OPENAI_BASE_URL=https://api.openai.com/v1
CHAT_MODEL=gpt-4
MAX_TOKENS=4000          # Integer, 1-32000
TEMPERATURE=0.7          # Number, 0-2

# Text Chunking
CHUNK_SIZE=1000          # Integer, 100-8000 characters
CHUNK_OVERLAP=200        # Integer, 0-500 characters (must be < CHUNK_SIZE)

# File Paths
VECTOR_STORE_PATH=./data/vector-store.json
CHAT_HISTORY_PATH=./data/chat-history.json

# Behavior
MAX_CONTEXT_MESSAGES=10  # Integer, 1-50
MAX_SOURCE_RESULTS=5     # Integer, 1-20
MIN_SIMILARITY=0.7       # Number, 0-1

# System
LOG_LEVEL=info           # debug|info|warn|error
API_TIMEOUT_MS=30000     # Milliseconds
EXCLUDED_ARTICLE_IDS=    # Comma-separated article IDs to skip
```

### Environment Validation

The application uses **Zod** for robust environment validation with helpful error messages:

```bash
# Validate your environment setup
npm run check-env
```

Example validation output:

```
✅ All environment variables are valid

Current Configuration:
──────────────────────────────────────────────────
OpenAI:
  API Key: sk-test-...
  Base URL: https://api.openai.com/v1
  Embedding Model: text-embedding-3-small
  Chat Model: gpt-4
  Max Tokens: 4000
  Temperature: 0.7
```

### Getting API Credentials

#### TNG Embedding Server

This project requires a custom TNG (Text and Graph) embedding server for generating vector embeddings. You'll need:

1. Access to a deployed TNG embedding server
2. An API key for authentication
3. The server's base URL

#### OpenAI API Key

1. Go to [OpenAI API Keys](https://platform.openai.com/api-keys)
2. Create a new API key
3. Copy the key to your `.env` file

#### Zendesk Authentication

**Option 1: OAuth (Recommended)**

1. Set up OAuth application in Zendesk Admin
2. Obtain access token from `/oauth/tokens` endpoint
3. Use `ZENDESK_OAUTH_TOKEN` in your `.env` file

**Option 2: API Token**

1. In Zendesk Admin, go to **Apps and integrations** > **APIs** > **Zendesk API**
2. Enable token access
3. Generate a new API token
4. Use your email address and the token for authentication

## Usage

### Running the CLI

#### Development Mode

```bash
npm run dev
```

#### Production Mode

```bash
npm start
```

Or if installed globally:

```bash
rag-zendesk
```

### CLI Commands

Once the application starts, you'll see an interactive menu with these options:

- **chat** - Start chatting with the AI assistant
- **reindex** - Reindex Zendesk articles and rebuild embeddings
- **clear** - Clear chat history
- **stats** - Show system statistics
- **exit** - Exit the application

### First Run

1. Start the application: `npm run dev`
2. Select "reindex" to fetch articles from Zendesk and create embeddings
3. Wait for the indexing process to complete
4. Select "chat" to start asking questions

### Chat Interface

In chat mode:

- Type your questions about the articles
- The AI will search for relevant content and provide contextual answers
- Source articles are listed below each response
- Type "exit" to return to the main menu

## Project Structure

```
rag-poc/
├── src/
│   ├── index.ts          # Main CLI orchestrator
│   ├── types.ts          # TypeScript interfaces and Zod schemas
│   ├── config.ts         # Environment validation with Zod
│   ├── zendesk-oauth.ts  # Zendesk API client with OAuth support
│   ├── embeddings.ts     # TNG embedding service
│   ├── vectorstore.ts    # File-based vector storage
│   └── chat.ts           # Chat service with history
├── scripts/
│   └── check-env.js      # Environment validation script
├── data/                 # Generated at runtime
│   ├── vector-store.json # Embeddings and article data
│   └── chat-history.json # Conversation history
├── .env.example          # Environment template
├── package.json          # Dependencies and scripts
└── tsconfig.json         # TypeScript configuration
```

## Technical Details

### RAG Pipeline

1. **Data Ingestion**: Fetch articles from Zendesk API with OAuth/API token auth
2. **Text Processing**: Convert HTML to plain text using Cheerio
3. **Chunking**: Split articles into overlapping chunks with word/sentence preservation
4. **Embedding**: Create vector embeddings using custom TNG embedding server
5. **Storage**: Store embeddings in JSON file for persistence
6. **Retrieval**: Search relevant chunks using cosine similarity with recency boost
7. **Generation**: Generate responses using OpenAI with retrieved context

### Chunking Strategy

- Default chunk size: 1000 characters
- Overlap: 200 characters (configurable, validated to be < chunk size)
- Preserves word and sentence boundaries
- Maintains context across chunk boundaries
- Incremental reindexing for efficiency

### Rate Limiting

- **Zendesk**: 200 requests/minute, 700 requests/hour
- **TNG Embedding**: 100 requests/minute, 50K tokens/minute (configurable)
- **OpenAI**: 500 requests/minute, 150K tokens/minute
- Exponential backoff retry strategy with configurable timeouts

### Vector Search

- Cosine similarity for semantic search
- Configurable similarity threshold
- Recency boost for newer articles
- Source attribution with relevance scores

## Configuration Options

All configuration can be customized via environment variables:

| Variable               | Default                  | Description                         |
| ---------------------- | ------------------------ | ----------------------------------- |
| `EMBEDDING_MODEL`      | `BAAI/bge-large-en-v1.5` | TNG embedding model                 |
| `CHAT_MODEL`           | `gpt-4`                  | OpenAI chat model                   |
| `MAX_TOKENS`           | `4000`                   | Maximum tokens for responses        |
| `TEMPERATURE`          | `0.7`                    | Response creativity (0-2)           |
| `CHUNK_SIZE`           | `1000`                   | Text chunk size in characters       |
| `CHUNK_OVERLAP`        | `200`                    | Overlap between chunks              |
| `MAX_CONTEXT_MESSAGES` | `10`                     | Max chat history messages           |
| `MAX_SOURCE_RESULTS`   | `5`                      | Max source articles in responses    |
| `MIN_SIMILARITY`       | `0.7`                    | Minimum similarity threshold        |
| `API_TIMEOUT_MS`       | `30000`                  | API request timeout in milliseconds |

## Development

### Scripts

- `npm run build` - Compile TypeScript to dist/
- `npm run dev` - Run in development mode (with experimental TypeScript support)
- `npm run start` - Run in development mode (same as dev)
- `npm run start:compiled` - Run compiled application from dist/
- `npm run type-check` - Type checking only (no emit)
- `npm run lint` - Run ESLint on source files
- `npm run clean` - Remove build files
- `npm run check-env` - Validate environment variables with Zod
- `npm run setup` - Full setup: install, type-check, and validate environment

### Project Architecture

The application follows a modular architecture:

- **CLI Layer**: Interactive interface using Inquirer
- **Service Layer**: Business logic for each domain
- **API Layer**: External API clients with rate limiting
- **Storage Layer**: File-based persistence

### Adding Features

1. Define types in `src/types.ts`
2. Implement service logic in appropriate modules
3. Add CLI commands in `src/index.ts`
4. Update documentation

## Troubleshooting

### Common Issues

**"Missing required environment variable"**

- Ensure all required variables are set in `.env`
- Check variable names match exactly

**"Environment validation failed"**

- Run `npm run check-env` for detailed error messages
- Ensure all required variables are set in `.env`
- Check data types (emails, numbers, URLs) are valid

**"Failed to connect to Zendesk API"**

- Verify Zendesk credentials
- Check subdomain format (without `.zendesk.com`)
- Ensure API token access is enabled

**"OpenAI API error"**

- Verify API key is valid
- Check account has sufficient credits
- Verify model availability

**"Rate limit exceeded"**

- Application will automatically retry
- Consider reducing chunk size or batch sizes

### Performance Tips

- Tune `CHUNK_SIZE` and `CHUNK_OVERLAP` for your content
- Adjust `MIN_SIMILARITY` threshold for search quality vs. recall
- Enable verbose logging for debugging: set `LOG_LEVEL=debug`
- Use `EXCLUDED_ARTICLE_IDS` to skip problematic articles

### Data Management

- Vector store is saved in `./data/vector-store.json`
- Chat history is in `./data/chat-history.json`
- Delete these files to reset the application

## Proof of Concept Notes

This project demonstrates a complete RAG implementation but was built as a learning tool and proof of concept. Here are some considerations for production use:

### What's Included ✅

- ✅ Complete RAG pipeline with Zendesk integration
- ✅ Type-safe configuration with Zod validation
- ✅ Rate limiting and error handling
- ✅ Incremental indexing for efficiency
- ✅ Interactive CLI with good UX
- ✅ Comprehensive logging and monitoring

### Production Considerations 🚧

- **Database**: Currently uses file-based storage; consider PostgreSQL with pgvector for production
- **Scalability**: Single-threaded processing; consider worker queues for large datasets
- **Authentication**: OAuth implementation could be more robust
- **Monitoring**: Add proper metrics and health checks
- **Testing**: Add comprehensive unit and integration tests
- **Security**: Review API key handling and implement proper secrets management
- **Deployment**: Add Docker containerization and deployment scripts

### Custom TNG Embedding Server

This project uses a custom TNG (Text and Graph) embedding server rather than standard OpenAI embeddings. This was likely chosen for:

- Cost efficiency for large-scale embedding generation
- Custom model fine-tuning for domain-specific content
- Data privacy and control over the embedding process
- Performance optimization for the specific use case

For a simpler setup, you could modify the code to use OpenAI's embedding API directly.

## License

This project is licensed under the **GNU General Public License v3.0** - see the [LICENSE](LICENSE) file for details.

**Copyright (C) 2025 Luca Becker** - <hello@luca-becker.me> - [luca-becker.me](https://luca-becker.me)

This is free software: you are free to change and redistribute it under the terms of the GPL v3.0. There is NO WARRANTY, to the extent permitted by law.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## Support

For issues and questions:

- Check the troubleshooting section
- Review error logs for specific error messages
- Open an issue with reproduction steps
