import { randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type HeadObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import type { Member } from '../domain/entities.js';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const PENDING_CACHE_CONTROL = 'private,no-store,max-age=0';
const AVATAR_CACHE_CONTROL = 'private,no-store,max-age=0';
const IMMUTABLE_CACHE_CONTROL = 'public,max-age=31536000,immutable';
const UPLOAD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:jpg|png|webp)$/;

const extensions: Record<'image/jpeg' | 'image/png' | 'image/webp', string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const contentTypesByExtension = new Map(
  Object.entries(extensions).map(([contentType, extension]) => [extension, contentType]),
);

export interface ImageUploadInput {
  contentType: keyof typeof extensions;
  fileSize: number;
}

export interface PresignedImageUpload {
  expiresInSeconds: number;
  fields: Record<string, string>;
  uploadId: string;
  uploadUrl: string;
}

export interface FinalizedImage {
  publicUrl: string;
}

export type MediaResourceType = 'event' | 'project' | 'team';

export interface MediaService {
  createAvatarUpload(member: Member, input: ImageUploadInput): Promise<PresignedImageUpload>;
  createResourceImageUpload(
    resourceType: MediaResourceType,
    resourceId: string,
    input: ImageUploadInput,
  ): Promise<PresignedImageUpload>;
  deleteManagedImage(publicUrl: string, expectedKeyPrefix: string): Promise<void>;
  deleteMemberAvatar(member: Member): Promise<void>;
  finalizeAvatarUpload(member: Member, uploadId: string): Promise<FinalizedImage | undefined>;
  finalizeResourceImageUpload(
    resourceType: MediaResourceType,
    resourceId: string,
    uploadId: string,
  ): Promise<FinalizedImage | undefined>;
}

interface ValidImageMetadata {
  bytes: Uint8Array;
  contentType: keyof typeof extensions;
}

function isMissingObject(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'NoSuchKey' ||
      error.name === 'NotFound' ||
      (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode === 404)
  );
}

function isPreconditionFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'PreconditionFailed' ||
      (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode === 412)
  );
}

function resourceFolder(resourceType: MediaResourceType): 'events' | 'projects' | 'teams' {
  if (resourceType === 'project') return 'projects';
  if (resourceType === 'team') return 'teams';
  return 'events';
}

export class S3MediaService implements MediaService {
  public constructor(
    private readonly bucketName: string,
    private readonly publicBaseUrl: string,
    private readonly client: S3Client = new S3Client({}),
  ) {}

  private async createImageUpload(
    pendingKeyPrefix: string,
    input: ImageUploadInput,
  ): Promise<PresignedImageUpload> {
    const expiresInSeconds = 300;
    const uploadId = `${randomUUID()}.${extensions[input.contentType]}`;
    const objectKey = `${pendingKeyPrefix}${uploadId}`;
    const post = await createPresignedPost(this.client, {
      Bucket: this.bucketName,
      Conditions: [
        ['content-length-range', 1, MAX_IMAGE_BYTES],
        ['eq', '$Content-Type', input.contentType],
        ['eq', '$Cache-Control', PENDING_CACHE_CONTROL],
      ],
      Expires: expiresInSeconds,
      Fields: {
        'Cache-Control': PENDING_CACHE_CONTROL,
        'Content-Type': input.contentType,
        key: objectKey,
      },
      Key: objectKey,
    });

    return {
      expiresInSeconds,
      fields: post.fields,
      uploadId,
      uploadUrl: post.url,
    };
  }

  public createAvatarUpload(
    member: Member,
    input: ImageUploadInput,
  ): Promise<PresignedImageUpload> {
    return this.createImageUpload(`pending/avatars/${member.id}/`, input);
  }

  public createResourceImageUpload(
    resourceType: MediaResourceType,
    resourceId: string,
    input: ImageUploadInput,
  ): Promise<PresignedImageUpload> {
    return this.createImageUpload(
      `pending/${resourceFolder(resourceType)}/${resourceId}/`,
      input,
    );
  }

  private objectKeyFromPublicUrl(
    publicUrl: string,
    expectedKeyPrefix: string,
  ): string | undefined {
    try {
      const base = new URL(this.publicBaseUrl);
      const candidate = new URL(publicUrl);
      const publicPathPrefix = `${base.pathname.replace(/\/$/, '')}/`;
      if (
        candidate.protocol !== 'https:' ||
        candidate.origin !== base.origin ||
        !candidate.pathname.startsWith(publicPathPrefix) ||
        candidate.username !== '' ||
        candidate.password !== '' ||
        candidate.search !== '' ||
        candidate.hash !== ''
      ) {
        return undefined;
      }
      const objectKey = decodeURIComponent(candidate.pathname.slice(publicPathPrefix.length));
      return objectKey.startsWith(expectedKeyPrefix) ? objectKey : undefined;
    } catch {
      return undefined;
    }
  }

  private async deleteObject(objectKey: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucketName, Key: objectKey }));
  }

  private async validateImageObject(
    objectKey: string,
    expectedContentType: keyof typeof extensions,
    deleteInvalid: boolean,
  ): Promise<ValidImageMetadata | undefined> {
    let metadata: HeadObjectCommandOutput;
    try {
      metadata = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucketName, Key: objectKey }),
      );
    } catch (error) {
      if (isMissingObject(error)) return undefined;
      throw error;
    }

    const invalidMetadata =
      metadata.ContentLength === undefined ||
      metadata.ContentLength < 1 ||
      metadata.ContentLength > MAX_IMAGE_BYTES ||
      metadata.ContentType !== expectedContentType ||
      typeof metadata.ETag !== 'string' ||
      metadata.ETag.length === 0;
    if (invalidMetadata) {
      if (deleteInvalid) await this.deleteObject(objectKey);
      return undefined;
    }

    let object;
    try {
      object = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucketName,
          IfMatch: metadata.ETag,
          Key: objectKey,
        }),
      );
    } catch (error) {
      if (isMissingObject(error)) return undefined;
      if (isPreconditionFailure(error)) {
        if (deleteInvalid) await this.deleteObject(objectKey);
        return undefined;
      }
      throw error;
    }
    const bytes = await object.Body?.transformToByteArray();
    const valid =
      bytes !== undefined &&
      bytes.length === metadata.ContentLength &&
      ((expectedContentType === 'image/jpeg' &&
        bytes.length >= 3 &&
        bytes[0] === 0xff &&
        bytes[1] === 0xd8 &&
        bytes[2] === 0xff) ||
        (expectedContentType === 'image/png' &&
          bytes.length >= 8 &&
          bytes[0] === 0x89 &&
          bytes[1] === 0x50 &&
          bytes[2] === 0x4e &&
          bytes[3] === 0x47 &&
          bytes[4] === 0x0d &&
          bytes[5] === 0x0a &&
          bytes[6] === 0x1a &&
          bytes[7] === 0x0a) ||
        (expectedContentType === 'image/webp' &&
          bytes.length >= 12 &&
          String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
          String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'));
    if (!valid) {
      if (deleteInvalid) await this.deleteObject(objectKey);
      return undefined;
    }
    return { bytes, contentType: expectedContentType };
  }

  private async finalizeImageUpload(
    pendingKeyPrefix: string,
    finalKeyPrefix: string,
    uploadId: string,
    cacheControl: string,
  ): Promise<FinalizedImage | undefined> {
    if (!UPLOAD_ID_PATTERN.test(uploadId)) return undefined;
    const extension = uploadId.slice(uploadId.lastIndexOf('.') + 1);
    const expectedContentType = contentTypesByExtension.get(extension) as
      | keyof typeof extensions
      | undefined;
    if (!expectedContentType) return undefined;

    const pendingKey = `${pendingKeyPrefix}${uploadId}`;
    const finalKey = `${finalKeyPrefix}${uploadId}`;
    const pendingMetadata = await this.validateImageObject(
      pendingKey,
      expectedContentType,
      true,
    );
    if (!pendingMetadata) {
      const finalizedMetadata = await this.validateImageObject(
        finalKey,
        expectedContentType,
        true,
      );
      return finalizedMetadata
        ? { publicUrl: `${this.publicBaseUrl}/${finalKey}` }
        : undefined;
    }

    try {
      await this.client.send(
        new PutObjectCommand({
          Body: pendingMetadata.bytes,
          Bucket: this.bucketName,
          CacheControl: cacheControl,
          ContentType: pendingMetadata.contentType,
          IfNoneMatch: '*',
          Key: finalKey,
        }),
      );
    } catch (error) {
      if (!isPreconditionFailure(error)) throw error;
      await this.deleteObject(pendingKey);
      const finalizedMetadata = await this.validateImageObject(
        finalKey,
        expectedContentType,
        true,
      );
      return finalizedMetadata
        ? { publicUrl: `${this.publicBaseUrl}/${finalKey}` }
        : undefined;
    }
    await this.deleteObject(pendingKey);
    return { publicUrl: `${this.publicBaseUrl}/${finalKey}` };
  }

  public finalizeAvatarUpload(
    member: Member,
    uploadId: string,
  ): Promise<FinalizedImage | undefined> {
    return this.finalizeImageUpload(
      `pending/avatars/${member.id}/`,
      `avatars/${member.id}/`,
      uploadId,
      AVATAR_CACHE_CONTROL,
    );
  }

  public finalizeResourceImageUpload(
    resourceType: MediaResourceType,
    resourceId: string,
    uploadId: string,
  ): Promise<FinalizedImage | undefined> {
    const folder = resourceFolder(resourceType);
    return this.finalizeImageUpload(
      `pending/${folder}/${resourceId}/`,
      `${folder}/${resourceId}/`,
      uploadId,
      IMMUTABLE_CACHE_CONTROL,
    );
  }

  public async deleteManagedImage(
    publicUrl: string,
    expectedKeyPrefix: string,
  ): Promise<void> {
    const objectKey = this.objectKeyFromPublicUrl(publicUrl, expectedKeyPrefix);
    if (objectKey) await this.deleteObject(objectKey);
  }

  public async deleteMemberAvatar(member: Member): Promise<void> {
    for (const prefix of [`avatars/${member.id}/`, `pending/avatars/${member.id}/`]) {
      let continuationToken: string | undefined;
      do {
        const page = await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.bucketName,
            ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
            Prefix: prefix,
          }),
        );
        const objects = (page.Contents ?? [])
          .map((object) => object.Key)
          .filter((objectKey): objectKey is string => objectKey !== undefined);
        if (objects.length > 0) {
          const deletion = await this.client.send(
            new DeleteObjectsCommand({
              Bucket: this.bucketName,
              Delete: { Objects: objects.map((Key) => ({ Key })), Quiet: true },
            }),
          );
          if ((deletion.Errors?.length ?? 0) > 0) {
            throw new Error('S3 failed to delete one or more member avatar objects.');
          }
        }
        continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (continuationToken);
    }
  }
}
