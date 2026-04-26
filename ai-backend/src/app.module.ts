import { Module } from '@nestjs/common';
import { AiModule } from './ai/ai.module';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [
    AiModule,
    ConfigModule.forRoot({
      isGlobal: true, // makes env available everywhere
    }),
  ],
})
export class AppModule {}