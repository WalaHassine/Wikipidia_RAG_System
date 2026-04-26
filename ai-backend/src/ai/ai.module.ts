import { Module } from '@nestjs/common';
import { Pool } from 'pg';
import { AiController } from './ai.controller';
import { EmbeddingService } from 'src/embedding/embedding.service';
import { ChatRepository } from 'src/db/chat.repository';

@Module({
  controllers: [AiController],
  providers: [
    EmbeddingService,
    ChatRepository,
    {
      provide: 'PG_POOL',
      useFactory: () =>
        new Pool({
          host: process.env.DB_HOST,
          port: Number(process.env.DB_PORT),
          database: process.env.DB_NAME,
          user: process.env.DB_USER,
          password: process.env.DB_PASSWORD,
        }),
    },
  ],
})
export class AiModule {}
