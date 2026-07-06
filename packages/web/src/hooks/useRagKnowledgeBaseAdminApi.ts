import useHttp from './useHttp';

export type RagKnowledgeBaseDrive = 'org' | 'shared';

export type RagKnowledgeBaseFile = {
  key: string;
  drive: RagKnowledgeBaseDrive;
  relativePath: string;
  size: number;
  lastModified: string | null;
};

export type RagKnowledgeBaseFilesResponse = {
  files: RagKnowledgeBaseFile[];
  nextToken?: string;
};

export type RagKnowledgeBaseUploadUrlRequest = {
  drive: RagKnowledgeBaseDrive;
  relativePath: string;
  contentType: string;
  size: number;
};

export type RagKnowledgeBaseUploadUrlResponse = {
  signedUrl: string;
  metadataSignedUrl: string;
  key: string;
  metadataKey: string;
  s3Uri: string;
  metadata: {
    metadataAttributes: Record<string, unknown>;
  };
};

export type RagKnowledgeBaseIngestionJobSummary = {
  ingestionJobId?: string;
  status?: string;
  startedAt?: string;
  updatedAt?: string;
  statistics?: Record<string, number>;
};

export type RagKnowledgeBaseIngestionJobsResponse = {
  ingestionJobSummaries?: RagKnowledgeBaseIngestionJobSummary[];
  nextToken?: string;
};

export type RagKnowledgeBaseStartIngestionResponse = {
  ingestionJob?: RagKnowledgeBaseIngestionJobSummary;
};

const useRagKnowledgeBaseAdminApi = () => {
  const http = useHttp();
  return {
    listFiles: (drive: RagKnowledgeBaseDrive) =>
      http.get<RagKnowledgeBaseFilesResponse>(
        `/rag-knowledge-base/admin/files?drive=${drive}`
      ),
    getUploadUrl: (request: RagKnowledgeBaseUploadUrlRequest) =>
      http.post<
        RagKnowledgeBaseUploadUrlResponse,
        RagKnowledgeBaseUploadUrlRequest
      >('/rag-knowledge-base/admin/upload-url', request),
    startIngestion: () =>
      http.post<RagKnowledgeBaseStartIngestionResponse, Record<string, never>>(
        '/rag-knowledge-base/admin/start-ingestion',
        {}
      ),
    listIngestionJobs: () =>
      http.get<RagKnowledgeBaseIngestionJobsResponse>(
        '/rag-knowledge-base/admin/ingestion-jobs?maxResults=10'
      ),
    deleteFiles: (keys: string[]) =>
      http.api.delete('/rag-knowledge-base/admin/files', {
        data: { keys },
      }),
  };
};

export default useRagKnowledgeBaseAdminApi;
