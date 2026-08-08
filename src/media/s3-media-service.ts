import { randomUUID } from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import type { Member, ResourceType } from '../domain/entities.js';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMMUTABLE_CACHE_CONTROL = 'public,max-age=31536000,immutable';

const extensions: Record<'image/jpeg' | 'image/png' | 'image/webp', string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export interface ImageUploadInput {
  contentType: keyof typeof extensions;
  fileSize: number;
}

export interface PresignedImageUpload {
  expiresInSeconds: number;
  fields: Record<string, string>;
  publicUrl: string;
  uploadUrl: string;
}

export interface MediaService {
  createAvatarUpload(member: Member, input: ImageUploadInput): Promise<PresignedImageUpload>;
  createResourceImageUpload(
    resourceType: ResourceType,
    resourceId: string,
    input: ImageUploadInput,
  ): Promise<PresignedImageUpload>;
}

export class S3MediaService implements MediaService {
  public constructor(
    private readonly bucketName: string,
    private readonly publicBaseUrl: string,
    private readonly client: S3Client = new S3Client({}),
  ) {}

  private async createImageUpload(
    objectKey: string,
    input: ImageUploadInput,
  ): Promise<PresignedImageUpload> {
    const expiresInSeconds = 300;
    const post = await createPresignedPost(this.client, {
      Bucket: this.bucketName,
      Conditions: [
        ['content-length-range', 1, MAX_IMAGE_BYTES],
        ['eq', '$Content-Type', input.contentType],
        ['eq', '$Cache-Control', IMMUTABLE_CACHE_CONTROL],
      ],
      Expires: expiresInSeconds,
      Fields: {
        'Cache-Control': IMMUTABLE_CACHE_CONTROL,
        'Content-Type': input.contentType,
        key: objectKey,
      },
      Key: objectKey,
    });

    return {
      expiresInSeconds,
      fields: post.fields,
      publicUrl: `${this.publicBaseUrl}/${objectKey}`,
      uploadUrl: post.url,
    };
  }

  public createAvatarUpload(
    member: Member,
    input: ImageUploadInput,
  ): Promise<PresignedImageUpload> {
    const extension = extensions[input.contentType];
    return this.createImageUpload(`avatars/${member.id}/${randomUUID()}.${extension}`, input);
  }

  public createResourceImageUpload(
    resourceType: ResourceType,
    resourceId: string,
    input: ImageUploadInput,
  ): Promise<PresignedImageUpload> {
    const extension = extensions[input.contentType];
    const resourceFolder = resourceType === 'project' ? 'projects' : 'teams';
    return this.createImageUpload(
      `${resourceFolder}/${resourceId}/${randomUUID()}.${extension}`,
      input,
    );
  }
}
