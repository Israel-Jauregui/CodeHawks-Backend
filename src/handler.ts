import { createApi } from './api.js';
import { loadConfig } from './config.js';
import { SqsNewsletterQueue } from './email/newsletter-queue.js';
import { S3MediaService } from './media/s3-media-service.js';
import { DynamoClubRepository } from './repositories/dynamo-club-repository.js';

const config = loadConfig();

export const handler = createApi({
  config,
  mediaService: new S3MediaService(config.mediaBucketName, config.mediaPublicBaseUrl),
  newsletterQueue: new SqsNewsletterQueue(config.newsletterQueueUrl),
  repository: new DynamoClubRepository(config.tableName),
});
