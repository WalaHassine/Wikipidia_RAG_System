import { Injectable } from "@nestjs/common";
import { OnModuleInit } from "@nestjs/common";
import { pipeline } from "@xenova/transformers";

@Injectable()
export class EmbeddingService implements OnModuleInit {
  private model: any;

  async onModuleInit() { await this.init(); }

  async init() {
    this.model = await pipeline(
      "feature-extraction",
      "Xenova/all-MiniLM-L6-v2"
    );
  }

  async embed(text: string): Promise<number[]> {
    const output = await this.model(text, {
      pooling: "mean",
      normalize: true,
    });
    return Array.from(output.data);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    
    const output = await this.model(texts, {
      pooling: "mean",
      normalize: true,
    });
    return output.tolist();
  }
}