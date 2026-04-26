import { config } from "dotenv";
// Fix 1: Default config() automatically looks for ".env". 
// If you specifically need "env", put config({ path: "env" }) back.
config(); 

import { WikipediaClient } from "src/ingest/wikipedia.client";
import { IngestService } from "../ingest/ingest.service";
import { EmbeddingService } from "src/embedding/embedding.service";
import { VectorRepository } from "src/db/vector.repositorty";
import { Pool } from "pg";

async function run() {
  //feel free to change these!!
    const aiCorpusTitles = [
        // Core Concepts
        "Artificial intelligence",
        "Machine learning",
        "Deep learning",
        "Artificial neural network",
        "Natural language processing",
        "Computer vision",
        "Reinforcement learning",
        
        // Architectures & Mechanisms
        "Transformer (machine learning model)",
        "Recurrent neural network",
        "Convolutional neural network",
        "Generative adversarial network",
        "Large language model",
        "Autoencoder",
        "Backpropagation",
        "Gradient descent",
        "Attention (machine learning)",
        "Word embedding",
        
        // Notable Models & Systems
        "GPT-4",
        "BERT (language model)",
        "AlphaGo",
        "Stable Diffusion",
        "Llama (language model)",
        "Gemini (language model)",
        "ChatGPT",
        "Midjourney",
        
        // Frameworks & Hardware
        "Graphics processing unit",
        "Tensor Processing Unit",
        "TensorFlow",
        "PyTorch",
        "CUDA",
        "Hugging Face",
        
        // History & Pioneers
        "History of artificial intelligence",
        "Alan Turing",
        "Geoffrey Hinton",
        "Yann LeCun",
        "Yoshua Bengio",
        "Turing test",
        
        // Ethics & Safety
        "AI alignment",
        "Algorithmic bias",
        "Hallucination (artificial intelligence)"
      ];

  console.log(`BEHOLD!! Starting batch ingestion of ${aiCorpusTitles.length} articles...\n`);
  
  const embedder = new EmbeddingService();
  await embedder.init();

  const pool = new Pool({
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || "ai_backend",
    user: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD || "postgres",
  });

  const service = new IngestService(
    new WikipediaClient(),
    embedder,
    new VectorRepository(pool)
  );

  for (const title of aiCorpusTitles) {
    console.log(`Ingesting: ${title}`);
    
    try {

      const result = await service.ingest({
        userId: "cli-system",
        topic: title,
        searchLimit: 3,
        topK: 3
      });

      const article = result.articles[0];
      if (article) {
        const icon = article.status === "ingested" ? "🟢" : 
                     article.status === "skipped-cached" ? "🟡" : "🔴";
        console.log(`  ${icon} [${article.status}] ${article.chunkCount} chunks`);
      }
    } catch (err) {
      console.error(`\n Failed to ingest ${title}:`, err);
    }
    
    await new Promise(resolve => setTimeout(resolve, 500)); 
  }

  await pool.end();
  process.exit(0);
}

run().catch((err) => {
  console.error("\n Fatal error during ingestion:");
  console.error(err);
  process.exit(1);
});