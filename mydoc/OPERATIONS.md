# 運用メモ

このリポジトリの日常運用メモです。主に、コストを抑えるためのデプロイ/削除サイクルをまとめています。

## デプロイ/削除サイクル（コスト最小化）

このリポジトリは、アイドル時の課金を避けるため、必要なときに作って使い終わったら削除する運用を想定しています。

```bash
npm run cdk:deploy -- --profile rag-poc-admin
# ... 使う ...
npm run cdk:destroy -- --profile rag-poc-admin
```

`cdk:destroy` は GenU/RAG 関連スタックをまとめて削除します。残るのは CDK bootstrap スタック（`CDKToolkit`）と、ほぼ空の assets 用 S3 バケット/ECR リポジトリだけです。これらは実質的に無料に近く、同じ AWS アカウント内の CDK プロジェクトで共有されるため、毎回削除する必要はありません。
