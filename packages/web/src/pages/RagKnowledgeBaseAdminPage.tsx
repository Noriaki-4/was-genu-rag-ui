import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  PiArrowsClockwise,
  PiCheckCircle,
  PiFile,
  PiFolderOpen,
  PiMagnifyingGlass,
  PiTrash,
  PiUpload,
  PiWarningCircle,
} from 'react-icons/pi';
import Button from '../components/Button';
import ButtonIcon from '../components/ButtonIcon';
import Select from '../components/Select';
import useRagKnowledgeBaseAdminApi, {
  RagKnowledgeBaseDrive,
  RagKnowledgeBaseFile,
} from '../hooks/useRagKnowledgeBaseAdminApi';

const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;
const CONCURRENT_UPLOADS = 4;
const SUPPORTED_EXTENSIONS = new Set([
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

type UploadStatus = 'queued' | 'uploading' | 'done' | 'error';

type UploadQueueItem = {
  id: string;
  file: File;
  relativePath: string;
  status: UploadStatus;
  error?: string;
};

const fileWithRelativePath = (file: File) =>
  file as File & { webkitRelativePath?: string };

const getRelativePath = (file: File): string =>
  fileWithRelativePath(file).webkitRelativePath || file.name;

const getExtension = (fileName: string): string => {
  const index = fileName.lastIndexOf('.');
  return index >= 0 ? fileName.slice(index).toLowerCase() : '';
};

const isSupportedFile = (file: File): boolean =>
  file.size > 0 &&
  file.size <= MAX_FILE_SIZE_BYTES &&
  SUPPORTED_EXTENSIONS.has(getExtension(file.name));

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  );
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};

const getFolderPath = (relativePath: string): string => {
  const segments = relativePath.split('/');
  segments.pop();
  return segments.join('/');
};

const uploadToSignedUrl = async (
  url: string,
  body: BodyInit,
  contentType: string
) => {
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
    },
    body,
  });
  if (!response.ok) {
    throw new Error(`S3 upload failed: ${response.status}`);
  }
};

const RagKnowledgeBaseAdminPage: React.FC = () => {
  const { t } = useTranslation();
  const [drive, setDrive] = useState<RagKnowledgeBaseDrive>('org');
  const [selectedFolder, setSelectedFolder] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [queue, setQueue] = useState<UploadQueueItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const {
    listFiles,
    getUploadUrl,
    startIngestion,
    listIngestionJobs,
    deleteFiles,
  } = useRagKnowledgeBaseAdminApi();
  const {
    data: fileResponse,
    mutate: mutateFiles,
    isLoading: filesLoading,
  } = listFiles(drive);
  const { data: jobResponse, mutate: mutateJobs } = listIngestionJobs();

  const files = useMemo(() => fileResponse?.files ?? [], [fileResponse?.files]);

  const folders = useMemo(() => {
    const folderSet = new Set<string>();
    files.forEach((file) => {
      const folder = getFolderPath(file.relativePath);
      if (folder) folderSet.add(folder);
    });
    return [...folderSet].sort((a, b) => a.localeCompare(b));
  }, [files]);

  const filteredFiles = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return files.filter((file) => {
      const folder = getFolderPath(file.relativePath);
      const folderMatched = !selectedFolder || folder === selectedFolder;
      const queryMatched =
        !query || file.relativePath.toLowerCase().includes(query);
      return folderMatched && queryMatched;
    });
  }, [files, searchQuery, selectedFolder]);

  const latestJob = jobResponse?.ingestionJobSummaries?.[0];
  const uploadSummary = useMemo(() => {
    return {
      queued: queue.filter((item) => item.status === 'queued').length,
      uploading: queue.filter((item) => item.status === 'uploading').length,
      done: queue.filter((item) => item.status === 'done').length,
      error: queue.filter((item) => item.status === 'error').length,
    };
  }, [queue]);

  const totalSize = useMemo(
    () => files.reduce((sum, file) => sum + file.size, 0),
    [files]
  );

  const driveOptions = useMemo(
    () => [
      { value: 'org', label: t('rag.admin.drive_org') },
      { value: 'shared', label: t('rag.admin.drive_shared') },
    ],
    [t]
  );

  const updateQueueItem = useCallback(
    (id: string, patch: Partial<UploadQueueItem>) => {
      setQueue((current) =>
        current.map((item) => (item.id === id ? { ...item, ...patch } : item))
      );
    },
    []
  );

  const handleStartIngestion = useCallback(async () => {
    setSyncing(true);
    try {
      await startIngestion();
      toast.success(t('rag.admin.sync_started'));
      await mutateJobs();
    } catch (error) {
      console.error(error);
      toast.error(t('rag.admin.sync_failed'));
    } finally {
      setSyncing(false);
    }
  }, [mutateJobs, startIngestion, t]);

  const handleFiles = useCallback(
    async (fileList: FileList | File[]) => {
      const items = Array.from(fileList)
        .filter(isSupportedFile)
        .map((file, index) => ({
          id: `${Date.now()}-${index}-${file.name}`,
          file,
          relativePath: getRelativePath(file),
          status: 'queued' as const,
        }));
      if (items.length === 0) {
        toast.error(t('rag.admin.no_supported_files'));
        return;
      }

      setQueue(items);
      setUploading(true);
      let cursor = 0;
      let successCount = 0;
      const workerCount = Math.min(CONCURRENT_UPLOADS, items.length);

      const uploadWorker = async () => {
        while (cursor < items.length) {
          const item = items[cursor++];
          updateQueueItem(item.id, { status: 'uploading', error: undefined });
          try {
            const contentType = item.file.type || 'application/octet-stream';
            const { data } = await getUploadUrl({
              drive,
              relativePath: item.relativePath,
              contentType,
              size: item.file.size,
            });
            await uploadToSignedUrl(data.signedUrl, item.file, contentType);
            await uploadToSignedUrl(
              data.metadataSignedUrl,
              JSON.stringify(data.metadata),
              'application/json'
            );
            updateQueueItem(item.id, { status: 'done' });
            successCount += 1;
          } catch (error) {
            console.error(error);
            updateQueueItem(item.id, {
              status: 'error',
              error:
                error instanceof Error
                  ? error.message
                  : t('rag.admin.upload_failed'),
            });
          }
        }
      };

      await Promise.all(
        Array.from({ length: workerCount }).map(() => uploadWorker())
      );
      setUploading(false);
      await mutateFiles();

      if (successCount > 0) {
        await handleStartIngestion();
      }
    },
    [drive, getUploadUrl, handleStartIngestion, mutateFiles, t, updateQueueItem]
  );

  const onSelectFiles = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      if (event.target.files) {
        handleFiles(event.target.files);
      }
      event.target.value = '';
    },
    [handleFiles]
  );

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      handleFiles(event.dataTransfer.files);
    },
    [handleFiles]
  );

  const toggleSelectedKey = useCallback((key: string) => {
    setSelectedKeys((current) =>
      current.includes(key)
        ? current.filter((currentKey) => currentKey !== key)
        : [...current, key]
    );
  }, []);

  const handleDelete = useCallback(async () => {
    if (selectedKeys.length === 0) return;
    if (!window.confirm(t('rag.admin.delete_confirm'))) return;
    try {
      await deleteFiles(selectedKeys);
      setSelectedKeys([]);
      await mutateFiles();
      toast.success(t('rag.admin.delete_done'));
    } catch (error) {
      console.error(error);
      toast.error(t('rag.admin.delete_failed'));
    }
  }, [deleteFiles, mutateFiles, selectedKeys, t]);

  const renderStatus = (status: UploadStatus) => {
    if (status === 'done') {
      return <PiCheckCircle className="text-green-600" />;
    }
    if (status === 'error') {
      return <PiWarningCircle className="text-red-600" />;
    }
    if (status === 'uploading') {
      return <PiArrowsClockwise className="text-aws-smile animate-spin" />;
    }
    return <PiFile className="text-gray-500" />;
  };

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-5">
      <div className="flex flex-col gap-3 border-b pb-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{t('rag.admin.title')}</h1>
          <div className="mt-2 flex flex-wrap gap-3 text-sm text-gray-600">
            <span>{t('rag.admin.file_count', { count: files.length })}</span>
            <span>{formatBytes(totalSize)}</span>
            <span>
              {latestJob?.status
                ? t('rag.admin.latest_sync', { status: latestJob.status })
                : t('rag.admin.no_sync')}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={drive}
            options={driveOptions}
            onChange={(value) => {
              setDrive(value as RagKnowledgeBaseDrive);
              setSelectedFolder('');
              setSelectedKeys([]);
            }}
          />
          <Button
            outlined
            loading={syncing}
            onClick={handleStartIngestion}
            className="gap-2">
            <PiArrowsClockwise />
            {t('rag.admin.sync')}
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[16rem_1fr_18rem]">
        <aside className="min-h-80 border-r pr-3">
          <div className="mb-2 text-sm font-semibold">
            {t('rag.admin.folders')}
          </div>
          <button
            className={`mb-1 flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm ${
              selectedFolder === '' ? 'bg-aws-smile/10 text-aws-smile' : ''
            }`}
            onClick={() => {
              setSelectedFolder('');
            }}>
            <PiFolderOpen />
            {t('rag.admin.all_files')}
          </button>
          <div className="max-h-[calc(100vh-18rem)] overflow-y-auto">
            {folders.map((folder) => (
              <button
                key={folder}
                className={`mb-1 flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm ${
                  selectedFolder === folder
                    ? 'bg-aws-smile/10 text-aws-smile'
                    : ''
                }`}
                onClick={() => {
                  setSelectedFolder(folder);
                }}>
                <PiFolderOpen className="shrink-0" />
                <span className="break-all">{folder}</span>
              </button>
            ))}
          </div>
        </aside>

        <main className="min-w-0">
          <div className="mb-3 flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
            <div className="relative w-full lg:max-w-md">
              <input
                className="w-full rounded border border-black/30 py-2 pl-9 pr-3 outline-none"
                value={searchQuery}
                placeholder={t('rag.admin.search')}
                onChange={(event) => {
                  setSearchQuery(event.target.value);
                }}
              />
              <PiMagnifyingGlass className="absolute left-3 top-3 text-gray-500" />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                outlined
                onClick={() => folderInputRef.current?.click()}
                disabled={uploading}
                className="gap-2">
                <PiFolderOpen />
                {t('rag.admin.select_folder')}
              </Button>
              <Button
                outlined
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="gap-2">
                <PiUpload />
                {t('rag.admin.select_files')}
              </Button>
              <Button
                outlined
                onClick={handleDelete}
                disabled={selectedKeys.length === 0}
                className="gap-2">
                <PiTrash />
                {t('rag.admin.delete')}
              </Button>
            </div>
          </div>

          <div
            className="mb-3 flex min-h-28 items-center justify-center rounded border border-dashed border-gray-300 bg-gray-50 text-sm text-gray-600"
            onDragOver={(event) => {
              event.preventDefault();
            }}
            onDrop={onDrop}>
            {uploading ? t('rag.admin.uploading') : t('rag.admin.drop_files')}
          </div>

          <input
            ref={fileInputRef}
            className="hidden"
            type="file"
            multiple
            onChange={onSelectFiles}
          />
          <input
            ref={folderInputRef}
            className="hidden"
            type="file"
            multiple
            {...{ webkitdirectory: '', directory: '' }}
            onChange={onSelectFiles}
          />

          <div className="overflow-x-auto border">
            <table className="w-full min-w-[42rem] text-left text-sm">
              <thead className="bg-gray-100 text-xs uppercase text-gray-600">
                <tr>
                  <th className="w-10 px-3 py-2"></th>
                  <th className="px-3 py-2">{t('rag.admin.file')}</th>
                  <th className="w-28 px-3 py-2">{t('rag.admin.size')}</th>
                  <th className="w-44 px-3 py-2">
                    {t('rag.admin.updated_at')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredFiles.map((file: RagKnowledgeBaseFile) => (
                  <tr key={file.key} className="border-t">
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={selectedKeys.includes(file.key)}
                        onChange={() => toggleSelectedKey(file.key)}
                      />
                    </td>
                    <td className="break-all px-3 py-2">{file.relativePath}</td>
                    <td className="px-3 py-2">{formatBytes(file.size)}</td>
                    <td className="px-3 py-2">
                      {file.lastModified
                        ? new Date(file.lastModified).toLocaleString()
                        : ''}
                    </td>
                  </tr>
                ))}
                {!filesLoading && filteredFiles.length === 0 && (
                  <tr>
                    <td
                      className="px-3 py-8 text-center text-gray-500"
                      colSpan={4}>
                      {t('rag.admin.no_files')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </main>

        <aside className="border-l pl-3">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-sm font-semibold">
              {t('rag.admin.upload_queue')}
            </div>
            <ButtonIcon
              title={t('rag.admin.refresh')}
              onClick={() => {
                mutateFiles();
                mutateJobs();
              }}>
              <PiArrowsClockwise />
            </ButtonIcon>
          </div>
          <div className="mb-3 grid grid-cols-2 gap-2 text-sm">
            <div>
              {t('rag.admin.queue_done', { count: uploadSummary.done })}
            </div>
            <div>
              {t('rag.admin.queue_error', { count: uploadSummary.error })}
            </div>
            <div>
              {t('rag.admin.queue_uploading', {
                count: uploadSummary.uploading,
              })}
            </div>
            <div>
              {t('rag.admin.queue_queued', { count: uploadSummary.queued })}
            </div>
          </div>
          <div className="max-h-80 space-y-2 overflow-y-auto">
            {queue.map((item) => (
              <div key={item.id} className="border-b pb-2 text-sm">
                <div className="flex items-start gap-2">
                  <span className="mt-1 shrink-0">
                    {renderStatus(item.status)}
                  </span>
                  <div className="min-w-0">
                    <div className="break-all">{item.relativePath}</div>
                    {item.error && (
                      <div className="mt-1 break-all text-xs text-red-600">
                        {item.error}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
            {queue.length === 0 && (
              <div className="py-8 text-center text-sm text-gray-500">
                {t('rag.admin.queue_empty')}
              </div>
            )}
          </div>

          <div className="mt-5 border-t pt-4">
            <div className="mb-2 text-sm font-semibold">
              {t('rag.admin.sync_history')}
            </div>
            <div className="space-y-2 text-sm">
              {(jobResponse?.ingestionJobSummaries ?? []).map((job) => (
                <div key={job.ingestionJobId} className="border-b pb-2">
                  <div className="font-medium">{job.status}</div>
                  <div className="break-all text-xs text-gray-500">
                    {job.ingestionJobId}
                  </div>
                  <div className="text-xs text-gray-500">
                    {job.updatedAt
                      ? new Date(job.updatedAt).toLocaleString()
                      : ''}
                  </div>
                </div>
              ))}
              {(jobResponse?.ingestionJobSummaries ?? []).length === 0 && (
                <div className="py-4 text-center text-gray-500">
                  {t('rag.admin.no_sync')}
                </div>
              )}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
};

export default RagKnowledgeBaseAdminPage;
