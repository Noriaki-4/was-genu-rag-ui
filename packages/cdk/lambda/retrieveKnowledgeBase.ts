import * as lambda from 'aws-lambda';
import {
  RetrievalFilter,
  RetrieveCommand,
} from '@aws-sdk/client-bedrock-agent-runtime';
import { RetrieveKnowledgeBaseRequest } from 'generative-ai-use-cases';
import { initBedrockAgentRuntimeClient } from './utils/bedrockClient';
import {
  getDynamicFilters,
  hiddenStaticExplicitFilters,
} from '@generative-ai-use-cases/common';
import { CognitoIdTokenPayload } from 'aws-jwt-verify/jwt-model';

const KNOWLEDGE_BASE_ID = process.env.KNOWLEDGE_BASE_ID;
const MODEL_REGION = process.env.MODEL_REGION as string;

const normalizeGroups = (groups: unknown): string[] | undefined => {
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
  return undefined;
};

const normalizePayload = (
  payload?: CognitoIdTokenPayload
): CognitoIdTokenPayload | undefined => {
  if (!payload) return undefined;
  const groups = normalizeGroups(payload['cognito:groups']);
  return groups
    ? ({ ...payload, 'cognito:groups': groups } as CognitoIdTokenPayload)
    : payload;
};

const getExplicitFilters = (
  payload?: CognitoIdTokenPayload
): RetrievalFilter | undefined => {
  const normalizedPayload = normalizePayload(payload);
  if (!normalizedPayload) return undefined;
  const aggregatedFilters: RetrievalFilter[] = [
    ...hiddenStaticExplicitFilters,
    ...getDynamicFilters(normalizedPayload),
  ];
  if (aggregatedFilters.length === 0) return undefined;
  if (aggregatedFilters.length === 1) return aggregatedFilters[0];
  return { andAll: aggregatedFilters };
};

export const handler = async (
  event: lambda.APIGatewayProxyEvent
): Promise<lambda.APIGatewayProxyResult> => {
  const req = JSON.parse(event.body!) as RetrieveKnowledgeBaseRequest;
  const query = req.query;

  if (!query) {
    return {
      statusCode: 400,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ error: 'query is not specified' }),
    };
  }

  const client = await initBedrockAgentRuntimeClient({ region: MODEL_REGION });
  const explicitFilters = getExplicitFilters(
    event.requestContext.authorizer?.claims as CognitoIdTokenPayload | undefined
  );
  const retrieveCommand = new RetrieveCommand({
    knowledgeBaseId: KNOWLEDGE_BASE_ID,
    retrievalQuery: { text: query },
    retrievalConfiguration: {
      vectorSearchConfiguration: {
        numberOfResults: 10,
        overrideSearchType: 'HYBRID',
        filter: explicitFilters,
      },
    },
  });
  const retrieveRes = await client.send(retrieveCommand);

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(retrieveRes),
  };
};
