# GenU 楽々RAG風 S3アップロードUI 実装計画

作成日: 2026-07-05

更新日: 2026-07-06

## 目的

GenU の RAG Knowledge Base 構成に、QommonsAI の「楽々RAG」に近い操作感で、ブラウザから S3 データソースへ文書をアップロードし、Bedrock Knowledge Base に同期できる UI を追加する。

まずは PoC/MVP として以下を実現する。

- フォルダ構造を維持した一括アップロード
- RAG 用 S3 データソースバケットへの保存
- Bedrock Knowledge Base の同期ジョブ起動
- 同期ジョブ履歴/ステータス表示
- アップロード済みファイルの一覧表示

QommonsAI 相当の高度機能、特にゴミ箱、Shift_JIS/CP932 自動変換、100MB ファイル対応、管理画面での高度なドライブ/フォルダ権限編集は後続フェーズで扱う。基本的なグループ権限フィルタは既存の `getDynamicFilters` 足場を活用し、MVP近辺で検証する。

## 参考情報

### QommonsAI 楽々RAGの公開情報

公開されている説明では、楽々RAGは「既存の庁内フォルダ構造を維持したままアップロードし、即RAG化する」機能。最大5階層、3段階ロール権限、フォルダ単位の参照範囲絞り込み、根拠ファイルリンク、対応形式 PDF/docx/xlsx/pptx/txt/CSV、UTF-8/Shift_JIS/CP932 対応が説明されている。

- https://prtimes.jp/main/html/rd/p/000000663.000088829.html

### Bedrock Knowledge Bases の制約

AWS 公式ドキュメント上、S3 データソースで通常扱える文書形式は `.txt`, `.md`, `.html`, `.doc/.docx`, `.csv`, `.xls/.xlsx`, `.pdf`。ソースファイル上限は 50MB。S3 データソースは inclusion prefix、メタデータファイル、増分同期に対応している。

- https://docs.aws.amazon.com/bedrock/latest/userguide/s3-data-source-connector.html
- https://docs.aws.amazon.com/bedrock/latest/userguide/knowledge-base-ds.html
- https://docs.aws.amazon.com/bedrock/latest/APIReference/API_agent_StartIngestionJob.html

## 現状整理

### GenUに既にあるもの

- RAG Knowledge Base チャット画面: `packages/web/src/pages/RagKnowledgeBasePage.tsx`
- KB検索 API: `POST /rag-knowledge-base/retrieve`
- RAG引用元S3ファイルの署名付きURLダウンロード: `packages/web/src/hooks/useRagFile.ts`
- 汎用ファイル添付用の署名付きURLアップロード: `packages/web/src/hooks/useFileApi.ts`, `packages/cdk/lambda/getFileUploadSignedUrl.ts`
  - ただし、これは拡張子/サイズ/パストラバーサル検証が弱いため、KB管理アップロードAPIの実装パターンとしてはそのまま流用しない。
- KB用S3データソースバケット: `packages/cdk/lib/rag-knowledge-base-stack.ts`
  - `RagKnowledgeBaseStack` には既に `knowledgeBaseId` / `dataSourceBucketName` の public property がある。
  - `create-stacks.ts` -> `generative-ai-use-cases-stack.ts` -> `construct/api.ts` を通って、既に `KNOWLEDGE_BASE_ID` はAPI Lambdaへ届いている。
  - KB用S3データソースバケット名も `knowledgeBaseDataSourceBucketName` としてAPI Constructまで届き、現在は read 権限が付与されている。
- KB S3 データソース prefix: `docs/`
- フィルタ設定の足場: `packages/common/src/custom/rag-knowledge-base.ts`
  - `userDefinedExplicitFilters` は `KbFilter` UI が読む設定駆動の明示フィルタ。
  - `getDynamicFilters(idTokenPayload)` には Cognito Group / SAML Group を RetrievalFilter に変換するコメントアウト済みサンプルがある。
  - サンプルメタデータの `group` は、この動的フィルタ例と対応している。

### 足りないもの

- KB用S3データソースバケットへのアップロードAPI
- KB用S3データソースバケットのファイル一覧API
- Bedrock Knowledge Base の S3 DataSource ID
  - 露出の仕組み全体は既にあるため、`rag-knowledge-base-stack.ts` の `CfnDataSource` を変数に代入し、`.ref` を1本追加で渡すのが主作業。
- `StartIngestionJob`, `ListIngestionJobs`, `GetIngestionJob` を呼ぶAPI
- 管理用UI
- フォルダ階層、ドライブ、メタデータの追加設計
- `/rag-knowledge-base/retrieve` と `bedrockKbApi` のフィルタ適用経路の整合
  - `bedrockKbApi` は `getDynamicFilters` / `userDefinedExplicitFilters` を使う。
  - `/rag-knowledge-base/retrieve` は現状 `RetrieveCommand` を直接投げており、同じフィルタが適用されていない。

## 実装方針

### MVPの範囲

最初のMVPでは、Knowledge Base RAG が有効な場合のみ表示する「ナレッジ管理」画面を追加する。

画面の主機能:

- ローカルフォルダ選択または複数ファイル選択
- `webkitRelativePath` を使った相対パス維持
- 対応拡張子/サイズの事前チェック
- S3へ並列アップロード
- アップロード後に同期ジョブ開始
- 同期ジョブの最新状態表示
- S3上の `docs/` 配下ファイル一覧表示

保存先キー:

```text
docs/private/<encoded-relative-path>
docs/shared/<encoded-relative-path>
docs/org/<encoded-relative-path>
```

MVPでは `org` のみ有効にしてもよい。UI上は後続拡張を見越してドライブ選択を置く。

### 非MVPの範囲

後続フェーズに回すもの:

- 削除済みファイルのゴミ箱/復元
- pptxの変換または代替取り込み
- Shift_JIS/CP932 のUTF-8変換
- 100MB対応
- ファイル差分同期の高度化

権限管理とフォルダ単位フィルタは、完全新規ではなく既存のフィルタ足場を活用できるため、MVP近辺で先に設計/検証する。

## アーキテクチャ

### フロントエンド

追加候補:

- `packages/web/src/pages/RagKnowledgeBaseAdminPage.tsx`
- `packages/web/src/hooks/useRagKnowledgeBaseAdminApi.ts`
- `packages/web/src/components/RagKnowledgeBaseAdmin/*`
- `packages/web/src/i18n/*` の文言追加
- `packages/web/src/main.tsx` に route 追加
- `packages/web/src/App.tsx` またはナビゲーションにメニュー追加

想定ルート:

```text
/rag-knowledge-base/admin
```

画面構成:

- 左: ドライブ/フォルダツリー
- 中央: ファイル一覧
- 上部: 検索、同期ボタン、アップロードボタン
- 右上: 最新同期ステータス、総ファイル数、概算容量

MVPではツリーを完全実装せず、S3 key から疑似ツリーを生成する。

### バックエンドAPI

既存の Express ルーター `packages/cdk/lambda/api/routes/ragKnowledgeBase.ts` に管理APIを追加する。

候補エンドポイント:

```text
GET  /rag-knowledge-base/admin/files?prefix=docs/org/
POST /rag-knowledge-base/admin/upload-url
POST /rag-knowledge-base/admin/start-ingestion
GET  /rag-knowledge-base/admin/ingestion-jobs
GET  /rag-knowledge-base/admin/ingestion-jobs/:jobId
DELETE /rag-knowledge-base/admin/files
```

MVPの実装順:

1. `upload-url`
2. `start-ingestion`
3. `ingestion-jobs`
4. `files`
5. `delete files`

### CDK/IAM

既存の `RagKnowledgeBaseStack` は `knowledgeBaseId` と `dataSourceBucketName` を既に public property として公開している。追加で必要なのは、`packages/cdk/lib/rag-knowledge-base-stack.ts` で作成している Bedrock S3 DataSource の ID だけ。

具体的には、`new bedrock.CfnDataSource(this, 'DataSource', ...)` を変数に代入し、`s3DataSource.ref` を `RagKnowledgeBaseStack` の public property として公開する。

追加する値:

- `knowledgeBaseDataSourceId`

既に通っている値:

- `knowledgeBaseId`
- `knowledgeBaseDataSourceBucketName` 相当の `dataSourceBucketName`
  - ただし現状はAPI Constructまで届き、IAM read権限に使われている段階。アップロードAPIで使うには、API Lambda環境変数にも明示的に渡す。

`packages/cdk/lib/create-stacks.ts` から `GenerativeAiUseCasesStack` に追加で渡し、`packages/cdk/lib/construct/api.ts` の Lambda 環境変数へ設定する。

環境変数案:

```text
KNOWLEDGE_BASE_ID
KNOWLEDGE_BASE_DATA_SOURCE_ID
KNOWLEDGE_BASE_DATA_SOURCE_BUCKET_NAME
MODEL_REGION
```

API Lambda に必要な権限:

- `s3:ListBucket`
- `s3:GetObject`
- `s3:PutObject`
- `s3:DeleteObject`
- `bedrock:StartIngestionJob`
- `bedrock:GetIngestionJob`
- `bedrock:ListIngestionJobs`
- `bedrock:ListDataSources` fallback用

KBデータソースバケットには現在 read 権限だけが付与されている。`packages/cdk/lib/utils/s3-access-policy.ts` の `allowS3AccessWithSourceIpCondition` は `write` accessType を既に持っており、`s3:Abort*`, `s3:DeleteObject*`, `s3:PutObject*` を付与できる。新規の専用S3ポリシーは原則不要で、同じユーティリティを `write` で追加呼び出しする。

注意: `dataSourceBucketName` は旧Kendra RAG、`knowledgeBaseDataSourceBucketName` はBedrock KB RAGのバケット名なので取り違えない。

## データ設計

### S3キー

基本形:

```text
docs/<drive>/<folder1>/<folder2>/<fileName>
```

例:

```text
docs/org/総務課/例規集/旅費規程.pdf
docs/shared/防災/避難所/運用マニュアル.docx
```

ブラウザから受け取った相対パスは、以下をチェックする。

- `..` を含めない
- 先頭 `/` を許可しない
- 空文字セグメントを除外
- 最大5階層までに制限するか、MVPでは警告のみ
- 制御文字を除外

### メタデータ

Bedrock KB の S3 metadata file を使う。各文書の隣に以下のようなファイルを置く。

```text
docs/org/総務課/例規集/旅費規程.pdf.metadata.json
```

既存サンプル `packages/cdk/rag-docs/docs/*.metadata.json` は、`metadataAttributes` 配下にフラットな値を置く形式を使っている。

```json
{
  "metadataAttributes": {
    "group": ["IT"],
    "year": 2024,
    "tag": ["AWS", "Amazon Bedrock"],
    "category": "AWS",
    "is_public": true,
    "title": "Amazon Bedrock User Guide",
    "language": "ja"
  }
}
```

MVPでは既存の流儀に合わせ、以下のようなフラット形式を採用する。

```json
{
  "metadataAttributes": {
    "drive": "org",
    "folder_path": "総務課/例規集",
    "group": ["IT"],
    "uploaded_by": "cognito-user-name",
    "uploaded_at": "2026-07-05T00:00:00.000Z"
  }
}
```

後続で `department`, `document_type` などを追加する。権限用の属性は、既存の `getDynamicFilters` サンプルに合わせるならまず `group` を使う。

補足: AWS docs には `value` / `type` / `includeForEmbedding` を明示する形式もあるが、このリポジトリの既存サンプルと `rag-knowledge-base.ts` のコメントはフラット形式を前提にしているため、MVPでは既存流儀を優先する。

検証事項: `.metadata.json` は `docs/` prefix 配下に置かれるため inclusionPrefixes にマッチする。Bedrock KB がメタデータファイルとして正しく扱い、通常文書としてインデックスしないことを、アップロードフローでも同期後に確認する。

## フェーズ別計画

### Phase 0: 足場確認

目的: 既存RAG KB構成を壊さず、管理機能を追加できる状態にする。

作業:

- `ragKnowledgeBaseEnabled` が true のときだけ管理UIを表示
- KB S3 DataSource ID を CDK から API Lambda へ追加で渡す
- API Lambda に Bedrock Agent client を追加
- KB検索/生成のフィルタ適用経路を棚卸しする
  - `bedrockKbApi.ts` の `RetrieveAndGenerateStreamCommand` 経路
  - `retrieveKnowledgeBase.ts` の `RetrieveCommand` 経路
  - Use Case Builder の `retrieveKnowledgeBase` 呼び出し経路
- `npm test` または CDK snapshot の影響確認

完了条件:

- Lambda環境変数に `KNOWLEDGE_BASE_DATA_SOURCE_ID` が入る
- 既存RAGチャットが動作する
- どの経路にフィルタを適用する必要があるかが明確になっている

### Phase 1: S3アップロードAPI

目的: ブラウザからKBデータソースバケットへ直接アップロードできるようにする。

作業:

- `POST /rag-knowledge-base/admin/upload-url` を追加
- request: `drive`, `relativePath`, `contentType`, `size`
- response: `signedUrl`, `s3Uri`, `key`
- 拡張子とサイズをAPI側でも検証
- メタデータJSON用の署名付きURLも返す、またはAPI側でPutObjectする

対応拡張子MVP:

```text
.pdf, .txt, .md, .html, .doc, .docx, .csv, .xls, .xlsx
```

完了条件:

- 署名付きURLで `docs/<drive>/...` にPUTできる
- S3上で相対フォルダ構造が維持される

### Phase 2: 同期API

目的: アップロード後にBedrock KB同期をUIから開始し、状態を確認できるようにする。

作業:

- `POST /rag-knowledge-base/admin/start-ingestion`
- `GET /rag-knowledge-base/admin/ingestion-jobs`
- `GET /rag-knowledge-base/admin/ingestion-jobs/:jobId`
- `StartIngestionJobCommand`, `ListIngestionJobsCommand`, `GetIngestionJobCommand` を使用
- 連打防止: `STARTING`, `IN_PROGRESS` があれば新規同期開始を抑制

完了条件:

- UI/APIから同期ジョブを開始できる
- 同期履歴とステータスが取れる

### Phase 3: 管理UI MVP

目的: 「楽々RAG風」の最低限の画面を作る。

作業:

- 管理ページ追加
- ファイル/フォルダ選択
- ドラッグ&ドロップ
- アップロードキュー表示
- 成功/失敗件数表示
- 同期開始ボタン
- 最新同期ステータス表示
- ファイル一覧表示

ブラウザ実装メモ:

- フォルダアップロードは `input type="file" webkitdirectory` を使う
- `File.webkitRelativePath` からS3キーを生成する
- 大量ファイル時は同時PUT数を3から5程度に制限する
- 1ファイルごとに progress/error 状態を持つ

完了条件:

- フォルダを選ぶだけでS3へ階層維持アップロードできる
- 同期開始後、RAGチャットでアップロード文書を参照できる

### Phase 4: フォルダフィルタ検索

目的: QommonsAIの「フォルダ単位で参照範囲を絞る」に近づける。これは完全新規ではなく、既存の `KbFilter` / `userDefinedExplicitFilters` を活用する。

作業:

- アップロード時に `drive`, `folder_path` メタデータを保存
- `packages/common/src/custom/rag-knowledge-base.ts` の `userDefinedExplicitFilters` に `drive` / `folder_path` を追加
- 既存の `KbFilter` UI に表示されることを確認
- `bedrockKbApi.ts` の `RetrieveAndGenerateStreamCommand` 経路でフィルタが効くことを確認
- `/rag-knowledge-base/retrieve` 経路にも同等の明示フィルタを適用するか、用途を限定する

完了条件:

- 指定したドライブ/フォルダ配下だけをRAG検索対象にできる
- `RetrieveAndGenerateStream` と `Retrieve` のフィルタ挙動差分が解消または明文化されている

### Phase 5: グループ権限フィルタ

目的: 「見せてはいけない資料を検索結果に出さない」状態にする。これも完全新規ではなく、既存の `getDynamicFilters(idTokenPayload)` のコメントアウト済みサンプルを有効化/調整する。

作業:

- アップロード時に `group` メタデータを保存
- `getDynamicFilters` の Cognito Group サンプルを有効化または要件に合わせて調整
- Cognito Group が無いユーザーの扱いを決める
  - 原則はアクセス不可
  - 管理者/検証用の例外グループを明示する
- `bedrockKbApi.ts` の生成経路でフィルタが強制付与されることを確認
- `/rag-knowledge-base/retrieve` 経路にも同じ強制フィルタを入れる
- 管理画面上の表示制御だけに依存しない

完了条件:

- 権限外グループの文書が検索結果/根拠リンクに出ない
- UIを迂回してAPIを叩いても権限フィルタが効く

### Phase 6: ファイル一覧/削除

目的: 管理画面として最低限の保守ができるようにする。

作業:

- `GET /rag-knowledge-base/admin/files`
- `DELETE /rag-knowledge-base/admin/files`
- S3 ListObjectsV2 を prefix 指定で呼ぶ
- `.metadata.json` は通常一覧から隠す
- 削除後に同期を促す

注意:

削除はS3オブジェクト削除だけではKB側の検索結果から即時消えない。削除後に同期ジョブを実行し、削除反映を確認する。

完了条件:

- アップロード済み文書を画面で確認できる
- 不要文書を削除し、同期でKBから反映できる

### Phase 7: 文字コード/形式拡張

目的: 自治体や庁内文書で現実的に出てくるファイルを扱いやすくする。

作業候補:

- `.txt`, `.csv` の Shift_JIS/CP932 を UTF-8 に変換
- `.pptx` は Textract/LibreOffice/Lambda container 等で PDF または text に変換
- 変換前ファイルと変換後ファイルの保持方針を決める
- 50MB超ファイルはMVPでは拒否し、後続で分割/変換を検討

完了条件:

- Shift_JIS/CP932 の文字化けを回避できる
- pptxの扱いについて運用ルールが明確になる

## 主要な実装タスク

### CDK

- `RagKnowledgeBaseStack` でS3用 `CfnDataSource` を変数化し `dataSourceId` を公開
- `GenerativeAiUseCasesStack` / `Api` props に dataSourceId を追加
- API Lambda環境変数へ dataSourceId を追加する
- KBデータソースバケットに `allowS3AccessWithSourceIpCondition(..., 'write', ...)` を追加する
- API Lambda IAM に Bedrock ingestion 権限を追加
- CDK snapshot 更新

### Lambda/API

- `packages/cdk/lambda/api/routes/ragKnowledgeBase.ts` に admin routes を追加
- `ragKnowledgeBaseAdmin.ts` などの handler を新規追加
- S3 key sanitize/validation helper 追加
- Bedrock Agent client helper 追加
- ingestion job API 追加
- S3 list/delete API 追加
- `retrieveKnowledgeBase.ts` に必要なフィルタ適用を追加する、またはこの簡易検索APIの利用範囲を明確化する

### Web

- `useRagKnowledgeBaseAdminApi` 追加
- `RagKnowledgeBaseAdminPage` 追加
- route/menu 追加
- upload queue state 追加
- folder picker/dropzone 追加
- sync status panel 追加
- file browser 追加
- `userDefinedExplicitFilters` による `drive` / `folder_path` フィルタ表示を確認
- i18n文言追加

### Tests

- S3 key sanitize の unit test
- API request validation の unit test
- `userDefinedExplicitFilters` / `getDynamicFilters` の期待フィルタ確認
- `RetrieveAndGenerateStream` と `Retrieve` のフィルタ適用確認
- CDK snapshot test
- フロントのビルド
- 手動E2E: 小さなPDF/TXT/CSVをアップロードして同期し、RAGチャットで根拠リンクを確認

## リスクと対策

### DataSource ID の扱い

CDKで作る `CfnDataSource` の ref がDataSource IDとして使える想定。既存KBを指定するケースではIDが取れないため、追加のCDK context `ragKnowledgeBaseDataSourceId` を用意する必要がある。

対策:

- 新規作成KB: CDKから自動注入
- 既存KB: `cdk.json` に dataSourceId を設定

### 既存KBを使う場合のバケット

既存KBではGenUがS3バケットを作っていない場合がある。

対策:

- `ragKnowledgeBaseDataSourceBucketName` を context で指定できるようにする
- 未指定なら管理UIを非表示またはエラー表示

### Bedrock KBのファイル制約

QommonsAIの公開仕様とBedrock KBの制約は一致しない。

対策:

- MVPではAWS公式対応形式/50MBに合わせる
- UIで非対応ファイルを明示
- 後続で変換パイプラインを追加

### 権限制御の誤実装

フォルダをUIで隠すだけでは、API経由検索で漏れる可能性がある。

対策:

- 権限制御は検索API側で強制する
- `bedrockKbApi.ts` と `retrieveKnowledgeBase.ts` の両方を確認し、片方だけにフィルタが入る状態を避ける
- `packages/common/src/custom/rag-knowledge-base.ts` の既存サンプルを優先活用する

### フィルタ経路の二重化

RAG KBには少なくとも2つの検索経路がある。

- 生成チャット: `predictStream.ts` -> `bedrockKbApi.ts` -> `RetrieveAndGenerateStreamCommand`
- 簡易検索: `/rag-knowledge-base/retrieve` -> `retrieveKnowledgeBase.ts` -> `RetrieveCommand`

現状、前者は `getDynamicFilters` / `userDefinedExplicitFilters` を集約するが、後者は素の `RetrieveCommand` でフィルタを適用していない。

対策:

- Phase 0で利用箇所を棚卸しする
- Phase 4/5で両経路のフィルタ適用を揃える
- 揃えない場合は `/retrieve` を管理/検証用途に限定し、権限付き検索には使わない

### 既存アップロードAPIの過信

`getFileUploadSignedUrl.ts` はKB管理アップロードに必要な拡張子/サイズ/パス検証を持たない。

対策:

- 署名付きURL発行の考え方だけ参考にする
- KB管理APIではサーバー側で必ず extension, size, drive, relativePath を検証する
- S3 key生成は専用helperに閉じ込める

### 大量ファイルアップロード

ブラウザから大量ファイルを同時PUTすると失敗しやすい。

対策:

- concurrencyを制限
- 失敗ファイルだけ再試行
- 1回あたりファイル数/総容量の上限を設ける

## 推奨MVPスコープ

最初に作るなら、この順番がよい。

1. CDKでS3 `CfnDataSource.ref` を捕まえ、`KNOWLEDGE_BASE_DATA_SOURCE_ID` をAPIへ追加で渡す
2. `bedrockKbApi.ts` と `retrieveKnowledgeBase.ts` のフィルタ適用差分を確認し、権限/フォルダフィルタをどちらにも効かせる方針を決める
3. `upload-url` と `start-ingestion` APIを作る
4. 最小UIでフォルダ選択アップロードと同期開始を実装する
5. `userDefinedExplicitFilters` に `drive` / `folder_path` を追加し、フォルダ絞り込みを確認する
6. `getDynamicFilters` の Cognito Group サンプルを有効化/調整し、`group` メタデータで権限フィルタを確認する
7. `ingestion-jobs` と `files` APIで状態表示を足す
8. チャット画面でアップロード文書が根拠リンク付きで返り、権限外文書が出ないことを確認する

このMVPが通れば、「GenUに楽々RAG風のS3アップロードUIを追加できる」ことを検証できる。権限とフォルダフィルタは既存足場を活かしてMVP近辺で確認し、ゴミ箱、文字コード、pptx対応はその後に段階的に足す。
