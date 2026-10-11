import mongoose from 'mongoose';
import { env } from './env.js';
import { logger } from './logger.js';

export async function connectDB() {
  mongoose.set('strictQuery', true);
  // Surface a missing index in development instead of silently collection-scanning.
  if (env.NODE_ENV !== 'production') mongoose.set('debug', false);

  try {
    const conn = await mongoose.connect(env.MONGO_URI, {
      serverSelectionTimeoutMS: 10_000,
      maxPoolSize: 20,
    });
    logger.info(
      { host: conn.connection.host, db: conn.connection.name },
      'MongoDB connected'
    );
  } catch (err) {
    logger.fatal({ err: { message: err.message } }, 'MongoDB connection failed');
    process.exit(1);
  }

  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  mongoose.connection.on('reconnected', () => logger.info('MongoDB reconnected'));
  mongoose.connection.on('error', (err) =>
    logger.error({ err: { message: err.message } }, 'MongoDB error')
  );

  return mongoose.connection;
}

export async function disconnectDB() {
  await mongoose.connection.close();
}
