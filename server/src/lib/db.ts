import mongoose from 'mongoose';
import { env } from '../config/env';
import { logger } from './logger';

export async function connectMongo(uri: string = env.MONGO_URI): Promise<void> {
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri);
  logger.info({ db: mongoose.connection.name }, 'mongo connected');
}

export async function disconnectMongo(): Promise<void> {
  await mongoose.disconnect();
}
