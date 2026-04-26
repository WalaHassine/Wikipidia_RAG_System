import { config } from 'dotenv';
config({ path: 'env' });
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );

  app.enableCors({ origin: true, methods: ['GET', 'POST'] });
  await app.listen(3001, '0.0.0.0');
}
bootstrap();