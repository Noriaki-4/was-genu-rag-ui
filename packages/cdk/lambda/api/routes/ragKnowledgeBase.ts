import { Request, Response, Router } from 'express';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import {
  GetIngestionJobCommand,
  ListIngestionJobsCommand,
  StartIngestionJobCommand,
} from '@aws-sdk/client-bedrock-agent';
import { handler as retrieveKnowledgeBaseHandler } from '../../retrieveKnowledgeBase';
import {
  initBedrockAgentClient,
  initKnowledgeBaseS3Client,
} from '../../utils/bedrockClient';
import { wrapHandler } from './helpers';

export const router = Router();

const MODEL_REGION = process.env.MODEL_REGION as string;
const KNOWLEDGE_BASE_ID = process.env.KNOWLEDGE_BASE_ID || '';
const DATA_SOURCE_ID = process.env.KNOWLEDGE_BASE_DATA_SOURCE_ID || '';
const DATA_SOURCE_BUCKET_NAME =
  process.env.KNOWLEDGE_BASE_DATA_SOURCE_BUCKET_NAME || '';
const ADMIN_GROUPS = (process.env.KNOWLEDGE_BASE_ADMIN_GROUPS || 'Admin')
  .split(',')
  .map((group) => group.trim())
  .filter(Boolean);
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;
const MAX_RELATIVE_PATH_SEGMENTS = 6;
const ALLOWED_DRIVES = ['org', 'shared'] as const;
const ALLOWED_EXTENSIONS = new Set([
  '.pdf',
  '.txt',
  '.md',
  '.html',
  '.doc',
  '.docx',
  '.csv',
  '.xls',
  '.xlsx',
]);
const ACTIVE_INGESTION_STATUSES = new Set(['STARTING', 'IN_PROGRESS']);

type Drive = (typeof ALLOWED_DRIVES)[number];
type RequestWithApiGateway = Request & {
  apiGateway?: {
    event?: {
      requestContext?: {
        authorizer?: {
          claims?: Record<string, unknown>;
        };
      };
    };
  };
};

type UploadUrlRequest = {
  drive?: string;
  relativePath?: string;
  contentType?: string;
  size?: number;
};

class BadRequestError extends Error {}
class MissingAdminConfigError extends Error {}
class ForbiddenError extends Error {}

const asyncRoute =
  (handler: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response) => {
    handler(req, res).catch((error) => {
      console.error(error);
      if (error instanceof BadRequestError) {
        res.status(400).json({ error: error.message });
        return;
      }
      if (error instanceof MissingAdminConfigError) {
        res
          .status(503)
          .json({ error: 'Knowledge Base admin configuration is missing' });
        return;
      }
      if (error instanceof ForbiddenError) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      res.status(500).json({ error: 'Internal server error' });
    });
  };

const requireKnowledgeBaseAdminConfig = () => {
  if (!KNOWLEDGE_BASE_ID || !DATA_SOURCE_ID || !DATA_SOURCE_BUCKET_NAME) {
    throw new MissingAdminConfigError(
      'Knowledge Base admin configuration is missing'
    );
  }
};

const getClaims = (req: Request): Record<string, unknown> =>
  ((req as RequestWithApiGateway).apiGateway?.event?.requestContext?.authorizer
    ?.claims ?? {}) as Record<string, unknown>;

const getStringClaim = (
  claims: Record<string, unknown>,
  key: string
): string | undefined =>
  typeof claims[key] === 'string' ? (claims[key] as string) : undefined;

const getUserGroups = (claims: Record<string, unknown>): string[] => {
  const groups = claims['cognito:groups'];
  if (Array.isArray(groups)) {
    return groups.filter((group): group is string => typeof group === 'string');
  }
  if (typeof groups === 'string') {
    return groups
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((group) => group.trim().replace(/^"|"$/g, ''))
      .filter(Boolean);
  }
  return ['public'];
};

const requireAdmin = (req: Request) => {
  const groups = getUserGroups(getClaims(req));
  if (!groups.some((group) => ADMIN_GROUPS.includes(group))) {
    throw new ForbiddenError('User is not a Knowledge Base admin');
  }
};

const assertDrive = (drive: string | undefined): Drive => {
  if (!drive || !ALLOWED_DRIVES.includes(drive as Drive)) {
    throw new BadRequestError('drive is invalid');
  }
  return drive as Drive;
};

const getExtension = (relativePath: string): string => {
  const fileName = relativePath.split('/').pop() || '';
  const dotIndex = fileName.lastIndexOf('.');
  return dotIndex >= 0 ? fileName.slice(dotIndex).toLowerCase() : '';
};

const hasControlCharacters = (value: string): boolean =>
  value.split('').some((char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127;
  });

const sanitizeRelativePath = (relativePath: string | undefined): string => {
  if (!relativePath) {
    throw new BadRequestError('relativePath is required');
  }
  const normalized = relativePath.replace(/\\/g, '/').trim();
  if (normalized.startsWith('/') || hasControlCharacters(normalized)) {
    throw new BadRequestError('relativePath is invalid');
  }
  const segments = normalized.split('/').filter(Boolean);
  if (
    segments.length === 0 ||
    segments.length > MAX_RELATIVE_PATH_SEGMENTS ||
    segments.some((segment) => segment === '.' || segment === '..')
  ) {
    throw new BadRequestError('relativePath is invalid');
  }
  const sanitized = segments.join('/');
  if (!ALLOWED_EXTENSIONS.has(getExtension(sanitized))) {
    throw new BadRequestError('file extension is not supported');
  }
  return sanitized;
};

const encodeRelativePath = (relativePath: string): string =>
  relativePath.split('/').map(encodeURIComponent).join('/');

const decodeKeySegment = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const toS3Key = (drive: Drive, relativePath: string): string =>
  `docs/${drive}/${encodeRelativePath(relativePath)}`;

const assertManageableKey = (key: string): string => {
  if (key.endsWith('.metadata.json')) {
    throw new BadRequestError('metadata files cannot be managed directly');
  }
  const segments = key.split('/');
  const drive = segments[1];
  if (
    segments[0] !== 'docs' ||
    !ALLOWED_DRIVES.includes(drive as Drive) ||
    segments.length < 3 ||
    !ALLOWED_EXTENSIONS.has(getExtension(key))
  ) {
    throw new BadRequestError('key is invalid');
  }
  return key;
};

const getFolderPath = (relativePath: string): string => {
  const segments = relativePath.split('/');
  segments.pop();
  return segments.join('/');
};

router.post('/retrieve', wrapHandler(retrieveKnowledgeBaseHandler));

router.post(
  '/admin/upload-url',
  asyncRoute(async (req, res) => {
    requireKnowledgeBaseAdminConfig();
    requireAdmin(req);
    const body = req.body as UploadUrlRequest;
    const drive = assertDrive(body.drive);
    const relativePath = sanitizeRelativePath(body.relativePath);
    if (
      typeof body.size !== 'number' ||
      body.size <= 0 ||
      body.size > MAX_FILE_SIZE_BYTES
    ) {
      res.status(400).json({ error: 'size is invalid' });
      return;
    }

    const key = toS3Key(drive, relativePath);
    const metadataKey = `${key}.metadata.json`;
    const claims = getClaims(req);
    const uploadedBy =
      getStringClaim(claims, 'cognito:username') ||
      getStringClaim(claims, 'email') ||
      getStringClaim(claims, 'sub') ||
      'unknown';
    const metadata = {
      metadataAttributes: {
        drive,
        folder_path: getFolderPath(relativePath),
        group: getUserGroups(claims),
        uploaded_by: uploadedBy,
        uploaded_at: new Date().toISOString(),
      },
    };

    const s3Client = await initKnowledgeBaseS3Client({ region: MODEL_REGION });
    const contentType = body.contentType || 'application/octet-stream';
    const signedUrl = await getSignedUrl(
      s3Client,
      new PutObjectCommand({
        Bucket: DATA_SOURCE_BUCKET_NAME,
        Key: key,
        ContentType: contentType,
      }),
      { expiresIn: 3600 }
    );
    const metadataSignedUrl = await getSignedUrl(
      s3Client,
      new PutObjectCommand({
        Bucket: DATA_SOURCE_BUCKET_NAME,
        Key: metadataKey,
        ContentType: 'application/json',
      }),
      { expiresIn: 3600 }
    );

    res.json({
      signedUrl,
      metadataSignedUrl,
      key,
      metadataKey,
      s3Uri: `s3://${DATA_SOURCE_BUCKET_NAME}/${key}`,
      metadata,
    });
  })
);

router.post(
  '/admin/start-ingestion',
  asyncRoute(async (req, res) => {
    requireKnowledgeBaseAdminConfig();
    requireAdmin(req);
    const client = await initBedrockAgentClient({ region: MODEL_REGION });
    const jobs = await client.send(
      new ListIngestionJobsCommand({
        knowledgeBaseId: KNOWLEDGE_BASE_ID,
        dataSourceId: DATA_SOURCE_ID,
        maxResults: 10,
      })
    );
    const activeJob = jobs.ingestionJobSummaries?.find((job) =>
      ACTIVE_INGESTION_STATUSES.has(job.status || '')
    );
    if (activeJob) {
      res.status(409).json({ error: 'ingestion job is already running' });
      return;
    }

    const result = await client.send(
      new StartIngestionJobCommand({
        knowledgeBaseId: KNOWLEDGE_BASE_ID,
        dataSourceId: DATA_SOURCE_ID,
      })
    );
    res.json(result);
  })
);

router.get(
  '/admin/ingestion-jobs',
  asyncRoute(async (req, res) => {
    requireKnowledgeBaseAdminConfig();
    requireAdmin(req);
    const client = await initBedrockAgentClient({ region: MODEL_REGION });
    const maxResults = Math.min(
      Math.max(Number(req.query.maxResults ?? 10), 1),
      100
    );
    const result = await client.send(
      new ListIngestionJobsCommand({
        knowledgeBaseId: KNOWLEDGE_BASE_ID,
        dataSourceId: DATA_SOURCE_ID,
        maxResults,
        nextToken:
          typeof req.query.nextToken === 'string'
            ? req.query.nextToken
            : undefined,
      })
    );
    res.json(result);
  })
);

router.get(
  '/admin/ingestion-jobs/:jobId',
  asyncRoute(async (req, res) => {
    requireKnowledgeBaseAdminConfig();
    requireAdmin(req);
    const client = await initBedrockAgentClient({ region: MODEL_REGION });
    const result = await client.send(
      new GetIngestionJobCommand({
        knowledgeBaseId: KNOWLEDGE_BASE_ID,
        dataSourceId: DATA_SOURCE_ID,
        ingestionJobId: req.params.jobId,
      })
    );
    res.json(result);
  })
);

router.get(
  '/admin/files',
  asyncRoute(async (req, res) => {
    requireKnowledgeBaseAdminConfig();
    requireAdmin(req);
    const drive = assertDrive(
      typeof req.query.drive === 'string' ? req.query.drive : 'org'
    );
    const prefix =
      typeof req.query.prefix === 'string' && req.query.prefix !== ''
        ? req.query.prefix
        : `docs/${drive}/`;
    if (!prefix.startsWith(`docs/${drive}/`)) {
      res.status(400).json({ error: 'prefix is invalid' });
      return;
    }

    const s3Client = await initKnowledgeBaseS3Client({ region: MODEL_REGION });
    const result = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: DATA_SOURCE_BUCKET_NAME,
        Prefix: prefix,
        MaxKeys: 1000,
        ContinuationToken:
          typeof req.query.nextToken === 'string'
            ? req.query.nextToken
            : undefined,
      })
    );
    const files = (result.Contents ?? [])
      .filter((object) => object.Key && !object.Key.endsWith('.metadata.json'))
      .map((object) => {
        const key = object.Key || '';
        const relativePath = key
          .replace(/^docs\/[^/]+\//, '')
          .split('/')
          .map(decodeKeySegment)
          .join('/');
        return {
          key,
          drive,
          relativePath,
          size: object.Size ?? 0,
          lastModified: object.LastModified?.toISOString() ?? null,
        };
      });
    res.json({
      files,
      nextToken: result.NextContinuationToken,
    });
  })
);

router.delete(
  '/admin/files',
  asyncRoute(async (req, res) => {
    requireKnowledgeBaseAdminConfig();
    requireAdmin(req);
    const keys: unknown[] = Array.isArray(req.body?.keys) ? req.body.keys : [];
    if (keys.length === 0 || keys.some((key) => typeof key !== 'string')) {
      res.status(400).json({ error: 'keys are invalid' });
      return;
    }
    const objectKeys = keys.map((key) => assertManageableKey(key as string));
    const objects = objectKeys.flatMap((key) => [
      { Key: key },
      { Key: `${key}.metadata.json` },
    ]);

    const s3Client = await initKnowledgeBaseS3Client({ region: MODEL_REGION });
    const result = await s3Client.send(
      new DeleteObjectsCommand({
        Bucket: DATA_SOURCE_BUCKET_NAME,
        Delete: {
          Objects: objects,
          Quiet: true,
        },
      })
    );
    res.json(result);
  })
);
