import type {
  PluginResourceDescriptor,
  PluginResourceEdit,
  PluginResourceListItem,
  PluginResourceListResult,
  PluginResourceMaterializeResult,
  PluginResourceMoveResult,
  PluginResourceReadResult,
  PluginResourceRef,
  PluginResourceSearchMatch,
  PluginResourceSearchOptions,
  PluginResourceSearchResult,
  PluginResourceStat,
  PluginResourceTrashOptions,
  PluginResourceTrashResult,
  PluginResourceVersion,
  PluginResourceWatchTarget,
  PluginResourceWriteConflictResult,
  PluginResourceWriteExpectedVersionResult,
  PluginResourceMutationResult,
} from '@hana/plugin-protocol';

export type MaybePromise<T> = T | Promise<T>;

export type JsonSchema = Record<string, unknown>;

export const HANA_BUS_SKIP = Symbol.for('hana.event-bus.skip');

export interface HanaToolResult {
  content?: Array<Record<string, unknown>>;
  details?: Record<string, unknown>;
}

export interface HanaSessionRef {
  sessionId: string;
  sessionPath?: string | null;
  legacySessionPath?: string | null;
}

export type HanaSessionTarget = string | HanaSessionRef | {
  sessionId?: string | null;
  sessionPath?: string | null;
  path?: string | null;
  legacySessionPath?: string | null;
};

export interface HanaSessionFile {
  id?: string | null;
  fileId?: string | null;
  sessionId?: string | null;
  sessionPath?: string | null;
  filePath?: string;
  realPath?: string;
  displayName?: string;
  filename?: string;
  label?: string;
  ext?: string | null;
  mime?: string;
  size?: number;
  kind?: string;
  isDirectory?: boolean;
  origin?: string;
  operations?: unknown[];
  createdAt?: number | string;
  storageKind?: string;
  status?: string;
  missingAt?: number | string | null;
  resource?: HanaResourceEnvelope;
  [key: string]: unknown;
}

export interface HanaResourceEnvelope {
  schemaVersion: 1;
  resourceId: string;
  name: string;
  studioId: string;
  type: 'file' | string;
  source: 'session_file' | string;
  sourceId?: string;
  fileId?: string;
  displayName?: string;
  filename?: string;
  ext?: string | null;
  mime?: string;
  size?: number | null;
  kind?: string;
  isDirectory?: boolean;
  origin?: string;
  operations?: string[];
  createdAt?: number | string;
  mtimeMs?: number;
  lifecycle: {
    status: string;
    missingAt: number | string | null;
  };
  storage: {
    provider: string;
    storageKind?: string;
    localOnly?: boolean;
  };
  links: {
    self: string;
    content?: string;
  };
  [key: string]: unknown;
}

export type HanaResourceRef = PluginResourceRef;
export type HanaResourceVersion = PluginResourceVersion;
export type HanaResourceDescriptor = PluginResourceDescriptor;
export type HanaResourceStat = PluginResourceStat;
export type HanaResourceReadResult = PluginResourceReadResult;
export type HanaResourceMutationResult = PluginResourceMutationResult;
export type HanaResourceWriteConflictResult = PluginResourceWriteConflictResult;
export type HanaResourceWriteExpectedVersionResult = PluginResourceWriteExpectedVersionResult;
export type HanaResourceMoveResult = PluginResourceMoveResult;
export type HanaResourceTrashOptions = PluginResourceTrashOptions;
export type HanaResourceTrashResult = PluginResourceTrashResult;
export type HanaResourceEdit = PluginResourceEdit;
export type HanaResourceListItem = PluginResourceListItem;
export type HanaResourceListResult = PluginResourceListResult;
export type HanaResourceSearchOptions = PluginResourceSearchOptions;
export type HanaResourceSearchMatch = PluginResourceSearchMatch;
export type HanaResourceSearchResult = PluginResourceSearchResult;
export type HanaResourceMaterializeResult = PluginResourceMaterializeResult;
export type HanaResourceWatchTarget = PluginResourceWatchTarget;

export interface HanaPluginResourceMutationOptions {
  emit?: boolean;
}

export interface HanaPluginResourceWatchOptions {
  purpose?: string | null;
  sessionRef?: HanaSessionRef | { sessionPath?: string | null; path?: string | null } | null;
  /** @deprecated Prefer sessionId/sessionRef on the invocation context. */
  sessionPath?: string | null;
}

export interface HanaResourceWatchSubscription {
  subscriptionId: string;
  resourceKeys: string[];
  unsubscribe(): boolean;
  close(): boolean;
}

export interface HanaPluginResources {
  stat(ref: HanaResourceRef | Record<string, unknown>): Promise<HanaResourceStat>;
  read(ref: HanaResourceRef | Record<string, unknown>): Promise<HanaResourceReadResult>;
  list(ref: HanaResourceRef | Record<string, unknown>): Promise<HanaResourceListResult>;
  search(ref: HanaResourceRef | Record<string, unknown>, options?: HanaResourceSearchOptions): Promise<HanaResourceSearchResult>;
  materialize(ref: HanaResourceRef | Record<string, unknown>): Promise<HanaResourceMaterializeResult>;
  write(ref: HanaResourceRef | Record<string, unknown>, content: string | Uint8Array | ArrayBuffer, options?: HanaPluginResourceMutationOptions): Promise<HanaResourceMutationResult>;
  writeExpectedVersion(ref: HanaResourceRef | Record<string, unknown>, content: string | Uint8Array | ArrayBuffer, expectedVersion: HanaResourceVersion, options?: HanaPluginResourceMutationOptions): Promise<HanaResourceWriteExpectedVersionResult>;
  edit(ref: HanaResourceRef | Record<string, unknown>, edits: HanaResourceEdit[], options?: HanaPluginResourceMutationOptions): Promise<HanaResourceMutationResult>;
  mkdir(ref: HanaResourceRef | Record<string, unknown>, options?: HanaPluginResourceMutationOptions): Promise<HanaResourceMutationResult>;
  delete(ref: HanaResourceRef | Record<string, unknown>, options?: HanaPluginResourceMutationOptions): Promise<HanaResourceMutationResult>;
  copy(from: HanaResourceRef | Record<string, unknown>, to: HanaResourceRef | Record<string, unknown>, options?: HanaPluginResourceMutationOptions): Promise<HanaResourceMutationResult>;
  rename(from: HanaResourceRef | Record<string, unknown>, to: HanaResourceRef | Record<string, unknown>, options?: HanaPluginResourceMutationOptions): Promise<HanaResourceMoveResult>;
  move(from: HanaResourceRef | Record<string, unknown>, to: HanaResourceRef | Record<string, unknown>, options?: HanaPluginResourceMutationOptions): Promise<HanaResourceMoveResult>;
  trash(ref: HanaResourceRef | Record<string, unknown>, trashOptions?: HanaResourceTrashOptions, options?: HanaPluginResourceMutationOptions): Promise<HanaResourceTrashResult>;
  watch(ref: HanaResourceRef | Record<string, unknown>, options?: HanaPluginResourceWatchOptions): HanaResourceWatchSubscription;
  subscribe(resources: Array<HanaResourceRef | Record<string, unknown>>, options?: HanaPluginResourceWatchOptions): HanaResourceWatchSubscription;
  resolveWatchTarget?(ref: HanaResourceRef | Record<string, unknown>, options?: HanaPluginResourceWatchOptions): HanaResourceWatchTarget;
}

export interface HanaExecutionBoundary {
  schemaVersion: 1;
  boundaryId: string;
  kind: 'local_process' | string;
  serverNodeId: string;
  studioId: string;
  workbench?: {
    kind: string;
    root: string | null;
    [key: string]: unknown;
  };
  sandbox?: {
    kind: string;
    enforcedBy?: string;
    [key: string]: unknown;
  };
  filesystem?: {
    policy: string;
    [key: string]: unknown;
  };
  network?: {
    policy: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface HanaSessionFileMediaItem {
  type: 'session_file';
  fileId: string;
  sessionId?: string | null;
  sessionPath?: string | null;
  filePath?: string;
  label?: string;
  mime?: string;
  size?: number;
  kind?: string;
  [key: string]: unknown;
}

export interface HanaStagedSessionFile {
  file?: HanaSessionFile | null;
  sessionFile?: HanaSessionFile | null;
  mediaItem: HanaSessionFileMediaItem;
}

export interface HanaMediaDetails {
  media: {
    items: HanaSessionFileMediaItem[];
  };
}

export interface HanaChatSurfaceCardOptions {
  title?: string;
  description?: string;
  mode?: 'transcript' | 'full' | string;
  composer?: boolean;
  aspectRatio?: string;
}

export interface HanaChatSurfaceCardDetails {
  type: 'chat.surface';
  pluginId: string;
  sessionId: string;
  sessionRef: HanaSessionRef;
  sessionPath?: string;
  title?: string;
  description: string;
  mode: 'transcript' | 'full' | string;
  composer?: boolean;
  aspectRatio?: string;
}

export interface HanaPluginNetworkFetchInit extends RequestInit {
  timeoutMs?: number;
  cacheTtlMs?: number;
  maxResponseBytes?: number;
}

export interface HanaPluginNetwork {
  fetch(input: string | URL | Request, init?: HanaPluginNetworkFetchInit): Promise<Response>;
}

export interface HanaToolContext {
  serverId: string;
  serverNodeId?: string;
  userId: string;
  studioId: string;
  connectionKind?: 'local' | 'lan' | 'custom_remote' | 'relay' | 'cloud' | string;
  credentialKind?: 'none' | 'loopback_token' | 'device_credential' | 'user_session' | string;
  platformAccountId?: string | null;
  officialServiceKind?: 'relay' | 'cloud_studio' | 'inference' | 'billing' | string | null;
  executionBoundary?: HanaExecutionBoundary;
  pluginId: string;
  pluginDir: string;
  dataDir: string;
  capabilities?: string[];
  sensitiveCapabilities?: string[];
  sessionId?: string | null;
  sessionRef?: HanaSessionRef | null;
  /** @deprecated Use sessionId/sessionRef. Kept for legacy plugins. */
  sessionPath?: string | null;
  bus: HanaEventBus;
  network: HanaPluginNetwork;
  resources: HanaPluginResources;
  config: HanaPluginConfigStore;
  log: HanaPluginLogger;
  registerSessionFile?: (input: Record<string, unknown>) => HanaSessionFile;
  stageFile?: (input: Record<string, unknown>) => HanaStagedSessionFile;
  [key: string]: unknown;
}

export type HanaToolSessionPermissionKind =
  | 'read'
  | 'read_only'
  | 'plugin_output'
  | 'session_file_output'
  | 'workspace_write'
  | 'external_side_effect'
  | 'review'
  | string;

export type HanaToolInvocationKind = 'read' | 'routine' | 'review';

export type HanaToolInvocationTargetType =
  | 'url'
  | 'browser_tab'
  | 'background_task'
  | 'channel'
  | 'channel_draft'
  | 'agent'
  | 'notification_route'
  | 'setting'
  | 'memory_store'
  | 'pinned_memory_item'
  | 'pinned_memory_query'
  | 'experience_category'
  | 'session_files'
  | 'terminal_process';

export interface HanaToolInvocationTarget {
  type: HanaToolInvocationTargetType;
  /** Exact wildcard-free identity, limited by the host to 4096 characters. */
  id: string;
  /** Display-only label for reviewer context. */
  label?: string;
}

export interface HanaToolInvocationDescriptor {
  action: string;
  kind: HanaToolInvocationKind;
  /** Stable capability id in the form `<tool-name>.<action>`. */
  capability: string;
  target?: HanaToolInvocationTarget;
  sideEffect?: Record<string, unknown>;
}

export interface HanaToolSessionPermission<Input = unknown> {
  /**
   * True means the tool only reads already-authorized data and may run in
   * read-only sessions without reviewer escalation.
   */
  readOnly?: boolean;
  /**
   * Host approval classification hint. Unknown or external side-effect kinds
   * remain reviewer-bound in Auto mode.
   */
  kind?: HanaToolSessionPermissionKind;
  /**
   * Override Auto-mode handling for a declared non-read tool.
   */
  auto?: 'allow' | 'review';
  description?: string;
  sideEffect?: Record<string, unknown>;
  describeSideEffect?: (input: Input) => Record<string, unknown> | null | undefined;
  /**
   * Synchronously classify one concrete invocation. Return null for an
   * unsupported action or invalid target so the host can fail closed.
   * Promise/thenable results are consumed safely and rejected. The descriptor
   * action is the resolver's stable permission action; the host does not infer
   * it from an optional input.action field or require those strings to match.
   *
   * Actor, server, and session identity are host-owned and must not appear in
   * the returned descriptor or sideEffect metadata.
   */
  resolveInvocation?: (input: Input) => HanaToolInvocationDescriptor | null;
}

export interface HanaToolDefinition<Input = unknown, Output = unknown> {
  name: string;
  description: string;
  parameters?: JsonSchema;
  promptSnippet?: string;
  promptGuidelines?: string;
  sessionPermission?: HanaToolSessionPermission<Input>;
  metadata?: Record<string, unknown>;
  invocationStyle?: 'sdk_tool' | 'pi_tool';
  execute(input: Input, ctx: HanaToolContext): MaybePromise<Output>;
}

export type HanaSlashPermission = 'anyone' | 'owner' | 'admin';
export type HanaSlashScope = 'session' | 'global';

export interface HanaCommandContext {
  [key: string]: unknown;
}

export interface HanaCommandResult {
  reply?: string;
  silent?: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface HanaCommandDefinition<Context = HanaCommandContext> {
  name: string;
  aliases?: string[];
  description?: string;
  scope?: HanaSlashScope;
  permission?: HanaSlashPermission;
  usage?: string;
  handler?: (ctx: Context) => MaybePromise<HanaCommandResult | void>;
  execute?: (ctx: Context) => MaybePromise<unknown>;
}

export type HanaProviderRuntimeKind = 'http' | 'oauth-http' | 'local-cli' | 'browser-cli' | 'plugin';
export type HanaMediaCapabilityName = 'imageGeneration' | 'videoGeneration' | 'speechGeneration' | string;
export type HanaMediaOutputKind = 'file_glob' | 'json_stdout' | 'url_stdout';
export type HanaCliBindingSource = 'prompt' | 'modelId' | 'inputFile' | 'outputDir' | 'size' | 'duration';

export type HanaCliArgBinding =
  | { literal: string }
  | { option: string; from: HanaCliBindingSource };

export interface HanaCliOutputContract {
  kind: HanaMediaOutputKind;
  directory?: HanaCliBindingSource | string;
  pattern?: string;
  [key: string]: unknown;
}

export interface HanaCliCommandSpec {
  executable: string;
  args: HanaCliArgBinding[];
  timeoutMs: number;
  output: HanaCliOutputContract;
}

export interface HanaProviderRuntime {
  kind: HanaProviderRuntimeKind;
  protocolId?: string;
  command?: HanaCliCommandSpec;
  [key: string]: unknown;
}

export interface HanaProviderChatCapability {
  projection?: 'models-json' | 'sdk-auth-alias' | 'none' | string;
  credentialSource?: 'provider-catalog' | 'auth-storage' | 'none';
  runtimeProviderId?: string;
  displayProviderId?: string;
  allowListSource?: string;
  [key: string]: unknown;
}

export interface HanaMediaReferenceImageLimits {
  min?: number;
  max?: number;
  [key: string]: unknown;
}

export interface HanaMediaInputLimits {
  referenceImages?: HanaMediaReferenceImageLimits;
  [key: string]: unknown;
}

export interface HanaProviderMediaMode {
  id: string;
  label?: string;
  parameterSchema?: JsonSchema;
  defaults?: Record<string, unknown>;
  inputLimits?: HanaMediaInputLimits;
  pricing?: Record<string, unknown>;
  agentHints?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface HanaProviderMediaModel {
  id: string;
  displayName?: string;
  protocolId: string;
  inputs?: string[];
  outputs?: string[];
  supportsEdit?: boolean;
  aliases?: string[];
  credentialLaneId?: string;
  modes?: HanaProviderMediaMode[];
  parameterSchema?: JsonSchema;
  defaults?: Record<string, unknown>;
  inputLimits?: HanaMediaInputLimits;
  [key: string]: unknown;
}

export interface HanaProviderCredentialLane {
  id: string;
  kind?: string;
  label?: string;
  [key: string]: unknown;
}

export interface HanaProviderMediaCapability {
  defaultModelId?: string;
  models: HanaProviderMediaModel[];
  credentialLanes?: HanaProviderCredentialLane[];
  [key: string]: unknown;
}

export interface HanaProviderCapabilities {
  chat?: HanaProviderChatCapability;
  media?: Partial<Record<HanaMediaCapabilityName, HanaProviderMediaCapability>>;
  [key: string]: unknown;
}

export interface HanaProviderSource {
  kind: 'builtin' | 'plugin' | 'user' | string;
  pluginId?: string;
  [key: string]: unknown;
}

export interface HanaProviderDefinition {
  id: string;
  displayName?: string;
  name?: string;
  authType?: 'api-key' | 'oauth' | 'none' | string;
  authJsonKey?: string;
  defaultBaseUrl?: string;
  defaultApi?: string;
  api?: string;
  models?: unknown[];
  runtime?: HanaProviderRuntime;
  capabilities?: HanaProviderCapabilities;
  source?: HanaProviderSource;
  [key: string]: unknown;
}

export type HanaExtensionFactory<Pi = unknown> = (pi: Pi) => MaybePromise<void>;

export interface HanaPluginConfigStore {
  get<T = unknown>(key: string, options?: HanaPluginConfigScopeOptions): MaybePromise<T | undefined>;
  getAll?(options?: HanaPluginConfigScopeOptions & { redacted?: boolean }): MaybePromise<Record<string, unknown>>;
  set<T = unknown>(key: string, value: T, options?: HanaPluginConfigScopeOptions): MaybePromise<void>;
  setMany?(values: Record<string, unknown>, options?: HanaPluginConfigScopeOptions): MaybePromise<Record<string, unknown>>;
  getSchema?(): JsonSchema;
}

export interface HanaPluginConfigScopeOptions {
  scope?: 'global' | 'per-agent' | 'per-session';
  agentId?: string;
  sessionId?: string;
  /** @deprecated Use sessionId. Kept for legacy config scopes. */
  sessionPath?: string;
}

export interface HanaSessionTurnContext {
  system?: string | Array<string | { text: string; label?: string }>;
  beforeUser?: string | Array<string | { text: string; label?: string }>;
  afterUser?: string | Array<string | { text: string; label?: string }>;
  metadata?: Record<string, unknown>;
}

export interface HanaSessionCreateInput {
  agentId?: string | null;
  cwd?: string | null;
  memoryEnabled?: boolean;
  model?: string | { id?: string; modelId?: string; provider?: string; providerId?: string };
  workspaceFolders?: string[];
  authorizedFolders?: string[];
  thinkingLevel?: string;
  permissionMode?: string;
  ownerPluginId?: string | null;
  kind?: string | null;
  sessionKind?: string | null;
  visibility?: 'public' | 'plugin_private' | 'private' | string;
}

export interface HanaSessionSendInput {
  text: string;
  context?: HanaSessionTurnContext | null;
  images?: unknown[];
  videos?: unknown[];
  audios?: unknown[];
  imageAttachmentPaths?: string[];
  videoAttachmentPaths?: string[];
  audioAttachmentPaths?: string[];
  [key: string]: unknown;
}

export interface HanaSessionListFilter {
  agentId?: string;
  ownerPluginId?: string;
  includePluginPrivate?: boolean;
}

export interface HanaSessionUpdateInput {
  title?: string;
  pinned?: boolean;
  projectId?: string | null;
  thinkingLevel?: string;
  permissionMode?: string;
  ownerPluginId?: string | null;
  kind?: string | null;
  visibility?: 'public' | 'plugin_private' | 'private' | string;
}

export interface HanaAgentCreateInput {
  id?: string;
  name: string;
  yuan?: string;
  ownerPluginId?: string | null;
  visibility?: 'public' | 'plugin_private' | 'private' | string;
  kind?: string | null;
  initialFiles?: Record<string, string>;
  initialMemory?: Record<string, unknown>;
  memoryPolicy?: { enabled?: boolean };
}

export interface HanaAgentUpdateInput {
  name?: string;
  yuan?: string;
  ownerPluginId?: string | null;
  visibility?: 'public' | 'plugin_private' | 'private' | string;
  kind?: string | null;
  memoryPolicy?: { enabled?: boolean };
  toolPolicy?: { disabled?: string[] };
  config?: Record<string, unknown>;
}

export interface HanaModelSampleInput {
  systemPrompt?: string;
  messages: Array<{ role: string; content: unknown }>;
  sessionId?: string;
  sessionRef?: HanaSessionRef;
  /** @deprecated Use sessionId/sessionRef. */
  sessionPath?: string;
  agentId?: string;
  temperature?: number;
  maxTokens?: number;
  operation?: string;
}

export interface HanaMediaProviderFilter {
  capability?: string;
}

export interface HanaMediaModelRef {
  providerId?: string;
  provider?: string;
  modelId?: string;
  model?: string;
  capability?: string;
  credentialLaneId?: string;
}

export type HanaSessionFileReference =
  | { kind: 'session_file'; fileId: string }
  | { type: 'session_file'; fileId: string };

export type HanaGenerateImageReference = HanaSessionFileReference;

export interface HanaMediaDelivery {
  mode?: 'session' | 'response' | string;
  ttlMs?: number;
  [key: string]: unknown;
}

export interface HanaGenerateImageInput {
  sessionId?: string;
  sessionRef?: HanaSessionRef;
  /** @deprecated Use sessionId/sessionRef. */
  sessionPath?: string;
  prompt: string;
  count?: number;
  image?: HanaGenerateImageReference | HanaGenerateImageReference[];
  referenceImages?: HanaGenerateImageReference[];
  ratio?: string;
  resolution?: string;
  quality?: string;
  mode?: string;
  options?: Record<string, unknown>;
  model?: string;
  provider?: string;
  input?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  delivery?: HanaMediaDelivery;
  deliveryMode?: string;
  deliveryTarget?: unknown;
}

export interface HanaGenerateVideoInput {
  sessionId?: string;
  sessionRef?: HanaSessionRef;
  /** @deprecated Use sessionId/sessionRef. */
  sessionPath?: string;
  prompt: string;
  image?: HanaGenerateImageReference | HanaGenerateImageReference[] | string;
  referenceImages?: HanaGenerateImageReference[];
  duration?: number;
  ratio?: string;
  resolution?: string;
  mode?: string;
  options?: Record<string, unknown>;
  model?: string;
  provider?: string;
  input?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  delivery?: HanaMediaDelivery;
  deliveryMode?: string;
  deliveryTarget?: unknown;
}

export interface HanaGenerateMediaInput {
  kind?: 'image' | 'video' | 'audio' | 'image_generation' | 'video_generation' | 'speech_recognition' | 'asr' | 'transcription' | string;
  type?: string;
  mediaKind?: string;
  sessionId?: string;
  sessionRef?: HanaSessionRef;
  /** @deprecated Use sessionId/sessionRef. */
  sessionPath?: string;
  fileId?: string;
  prompt?: string;
  image?: HanaGenerateImageReference | HanaGenerateImageReference[] | string;
  referenceImages?: HanaGenerateImageReference[];
  duration?: number;
  ratio?: string;
  resolution?: string;
  quality?: string;
  mode?: string;
  options?: Record<string, unknown>;
  model?: string;
  provider?: string;
  delivery?: HanaMediaDelivery;
  deliveryMode?: string;
  input?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface HanaTranscribeAudioInput {
  sessionId?: string;
  sessionRef?: HanaSessionRef;
  /** @deprecated Use sessionId/sessionRef. */
  sessionPath?: string;
  fileId: string;
  language?: string;
  providerId?: string;
  provider?: string;
  modelId?: string;
  model?: string;
}

export interface HanaTranscribeAudioResult {
  ok: true;
  transcription: unknown;
  taskId?: string;
  stream?: unknown;
}

export interface HanaEventBus {
  emit(event: unknown, sessionPath?: string | null): unknown;
  emit(type: string, payload?: unknown): unknown;
  subscribe(callback: (event: unknown, sessionPath?: string | null) => void, filter?: HanaBusSubscriptionFilter): () => void;
  subscribe(type: string, handler: (payload: unknown) => void): () => void;
  request<T = unknown>(type: string, payload?: unknown, options?: Record<string, unknown>): Promise<T>;
  hasHandler?(type: string): boolean;
  handle?(type: string, handler: (payload: unknown) => MaybePromise<unknown>): () => void;
  listCapabilities?(): HanaEventBusCapability[];
  getCapability?(type: string): HanaEventBusCapability | null;
}

export interface HanaPluginRouteRequestContext {
  pluginId: string;
  agentId: string | null;
  principal: Record<string, unknown> | null;
  capabilityGrant: {
    accessLevel: string;
    declaredPermissions: readonly string[];
    legacyDeclaration: boolean;
  };
  bus: Pick<HanaEventBus, 'request' | 'emit' | 'subscribe' | 'hasHandler' | 'getCapability' | 'listCapabilities'>;
}

export interface HanaPluginHonoLikeContext {
  get?(name: string): unknown;
}

export function getPluginRequestContext(c: HanaPluginHonoLikeContext): HanaPluginRouteRequestContext {
  if (!c || typeof c.get !== 'function') {
    throw new Error('getPluginRequestContext requires a Hono context with c.get(name)');
  }
  const requestContext = c.get('pluginRequestContext');
  if (!requestContext || typeof requestContext !== 'object') {
    throw new Error('getPluginRequestContext must be called inside a Hana plugin route handler');
  }
  const bus = (requestContext as Record<string, unknown>).bus;
  const request = bus && typeof bus === 'object'
    ? (bus as { request?: unknown }).request
    : null;
  if (typeof request !== 'function') {
    throw new Error('getPluginRequestContext found an invalid plugin route request context');
  }
  return requestContext as HanaPluginRouteRequestContext;
}

export interface HanaBusSubscriptionFilter {
  types?: string[] | Set<string>;
  [key: string]: unknown;
}

export interface HanaEventBusCapability {
  type: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  permission: string;
  errors: string[];
  stability: string;
  owner: string;
  since?: string;
  available?: boolean;
}

export interface HanaNormalizedUsage {
  input: {
    totalTokens: number | null;
    uncachedTokens: number | null;
  };
  output: {
    totalTokens: number | null;
    reasoningTokens: number | null;
  };
  cache: {
    readTokens: number | null;
    writeTokens: number | null;
    missTokens: number | null;
    hit: boolean | null;
    created: boolean | null;
    hitRatio: number | null;
    support: 'reported' | 'not_reported' | 'not_supported';
  };
  totalTokens: number | null;
  costTotal: number | null;
}

export type HanaUsageAttribution =
  | { kind: 'session'; agentId: string | null; sessionId?: string | null; sessionPath?: string | null }
  | { kind: 'phone_conversation'; agentId: string; conversationId: string; conversationType: 'channel' | 'dm'; sessionId?: string | null; sessionPath?: string | null }
  | { kind: 'memory'; agentId: string | null }
  | { kind: 'automation'; jobId?: string | null; runId?: string | null; agentId?: string | null }
  | { kind: 'plugin'; pluginId: string; agentId?: string | null; sessionId?: string | null; sessionPath?: string | null }
  | { kind: 'utility'; agentId?: string | null; sessionId?: string | null; sessionPath?: string | null }
  | { kind: 'unknown' };

export interface HanaUsageSource {
  subsystem: 'session' | 'phone' | 'memory' | 'automation' | 'subagent' | 'compaction' | 'plugin' | 'utility' | 'vision' | 'unknown' | string;
  operation: string;
  surface: 'desktop' | 'mobile' | 'bridge' | 'channel' | 'dm' | 'cron' | 'heartbeat' | 'system' | 'plugin' | 'unknown' | string;
  trigger: 'user' | 'manual' | 'threshold' | 'overflow' | 'daily' | 'scheduled' | 'startup' | 'tool' | 'unknown' | string;
  actor?: {
    kind: 'session' | 'phone_conversation' | 'automation' | 'plugin' | 'subagent' | 'unknown' | string;
    agentId?: string | null;
    sessionId?: string | null;
    sessionPath?: string | null;
    taskId?: string | null;
    [key: string]: unknown;
  };
  parent?: {
    kind: 'session' | 'phone_conversation' | 'automation' | 'plugin' | 'unknown' | string;
    sessionId?: string;
    sessionPath?: string;
    conversationId?: string;
    conversationType?: 'channel' | 'dm';
    taskId?: string;
    pluginId?: string;
    [key: string]: unknown;
  };
}

export interface HanaUsageLedgerEntry {
  schemaVersion: 1;
  requestId: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  status: 'ok' | 'error' | 'aborted' | 'usage_missing';
  source: HanaUsageSource;
  attribution: HanaUsageAttribution;
  model: {
    provider: string | null;
    modelId: string | null;
    api: string | null;
  };
  usage: HanaNormalizedUsage | null;
  rawUsageShape: string | null;
  error: {
    name: string | null;
    message: string | null;
  } | null;
}

export interface HanaUsageListFilter {
  since?: string;
  until?: string;
  attributionKind?: string;
  sessionId?: string;
  sessionPath?: string;
  agentId?: string;
  subsystem?: string;
  operation?: string;
  modelId?: string;
  provider?: string;
  status?: 'ok' | 'error' | 'aborted' | 'usage_missing' | string;
  limit?: number;
}

export interface HanaUsageListResult {
  entries: HanaUsageLedgerEntry[];
  nextCursor: string | null;
}

export interface HanaUsageEventMeta {
  sessionId?: string | null;
  sessionPath?: string | null;
  sessionRef?: HanaSessionRef | null;
}

export interface HanaPluginLogger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface HanaBusHandlerContext {
  serverId: string;
  serverNodeId?: string;
  userId: string;
  studioId: string;
  connectionKind?: 'local' | 'lan' | 'custom_remote' | 'relay' | 'cloud' | string;
  credentialKind?: 'none' | 'loopback_token' | 'device_credential' | 'user_session' | string;
  platformAccountId?: string | null;
  officialServiceKind?: 'relay' | 'cloud_studio' | 'inference' | 'billing' | string | null;
  executionBoundary?: HanaExecutionBoundary;
  pluginId: string;
  bus: HanaEventBus;
  network?: HanaPluginNetwork;
  resources?: HanaPluginResources;
  config?: HanaPluginConfigStore;
  log?: HanaPluginLogger;
  [key: string]: unknown;
}

export interface HanaBusHandlerDefinition<
  Payload = unknown,
  Result = unknown,
  Context extends HanaBusHandlerContext = HanaBusHandlerContext,
> {
  type: string;
  handle(payload: Payload, ctx: Context): MaybePromise<Result>;
}

export interface HanaPluginContext {
  serverId: string;
  serverNodeId?: string;
  userId: string;
  studioId: string;
  connectionKind?: 'local' | 'lan' | 'custom_remote' | 'relay' | 'cloud' | string;
  credentialKind?: 'none' | 'loopback_token' | 'device_credential' | 'user_session' | string;
  platformAccountId?: string | null;
  officialServiceKind?: 'relay' | 'cloud_studio' | 'inference' | 'billing' | string | null;
  executionBoundary?: HanaExecutionBoundary;
  pluginId: string;
  pluginDir: string;
  dataDir: string;
  capabilities?: string[];
  sensitiveCapabilities?: string[];
  sessionId?: string | null;
  sessionRef?: HanaSessionRef | null;
  /** @deprecated Use sessionId/sessionRef. Kept for legacy plugins. */
  sessionPath?: string | null;
  bus: HanaEventBus;
  network: HanaPluginNetwork;
  resources: HanaPluginResources;
  config: HanaPluginConfigStore;
  log: HanaPluginLogger;
  registerTool?: (tool: HanaToolDefinition) => () => void;
  registerSessionFile?: (input: Record<string, unknown>) => HanaSessionFile;
  stageFile?: (input: Record<string, unknown>) => HanaStagedSessionFile;
  [key: string]: unknown;
}

export type HanaPluginDisposable = () => void;

export interface HanaPluginLifecycleHelpers {
  register(disposable: HanaPluginDisposable): void;
}

export interface HanaPluginLifecycle {
  onload?(ctx: HanaPluginContext, helpers: HanaPluginLifecycleHelpers): MaybePromise<void>;
  onunload?(ctx: HanaPluginContext): MaybePromise<void>;
}

export interface HanaPluginInstance {
  ctx: HanaPluginContext;
  register: (disposable: HanaPluginDisposable) => void;
  onload?(): MaybePromise<void>;
  onunload?(): MaybePromise<void>;
}

export type HanaTaskStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'blocked'
  | 'recovering'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'aborted';

export interface HanaTaskProgress {
  current?: number;
  total?: number;
  percent?: number;
  message?: string;
}

export interface HanaTaskRecord {
  taskId: string;
  type: string;
  parentSessionPath?: string | null;
  pluginId?: string | null;
  agentId?: string | null;
  meta?: Record<string, unknown>;
  progress?: HanaTaskProgress | null;
  status: HanaTaskStatus;
  aborted?: boolean;
  createdAt?: number;
  updatedAt?: number;
  completedAt?: number;
  result?: unknown;
  error?: string;
}

export interface HanaTaskSchedule {
  scheduleId: string;
  type: string;
  pluginId?: string | null;
  agentId?: string | null;
  parentSessionPath?: string | null;
  payload?: unknown;
  meta?: Record<string, unknown>;
  intervalMs?: number | null;
  runAt?: number | string | null;
  enabled?: boolean;
  nextRunAt?: number | null;
  lastRunAt?: number | null;
  lastResult?: unknown;
  lastError?: string | null;
  runCount?: number;
}

export interface HanaTaskRegisterInput {
  taskId: string;
  type: string;
  parentSessionPath?: string | null;
  pluginId?: string | null;
  agentId?: string | null;
  meta?: Record<string, unknown>;
  persist?: boolean;
}

export interface HanaTaskUpdateInput {
  taskId: string;
  status?: HanaTaskStatus;
  progress?: HanaTaskProgress | null;
  meta?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
  parentSessionPath?: string | null;
  pluginId?: string | null;
  agentId?: string | null;
}

export interface HanaTaskScheduleInput {
  scheduleId: string;
  type: string;
  pluginId?: string | null;
  agentId?: string | null;
  parentSessionPath?: string | null;
  payload?: unknown;
  meta?: Record<string, unknown>;
  intervalMs?: number;
  runAt?: number | string | Date;
  enabled?: boolean;
}

const EMPTY_PARAMETERS: JsonSchema = { type: 'object', properties: {} };

export function defineTool<Input = unknown, Output = unknown>(
  definition: HanaToolDefinition<Input, Output>,
): HanaToolDefinition<Input, Output> & { parameters: JsonSchema } {
  return {
    ...definition,
    parameters: definition.parameters ?? EMPTY_PARAMETERS,
  };
}

export function defineCommand<Context = HanaCommandContext>(
  definition: HanaCommandDefinition<Context>,
): HanaCommandDefinition<Context> {
  return { ...definition };
}

export function defineProvider<T extends HanaProviderDefinition>(definition: T): T {
  return definition;
}

export function defineBusHandler<
  Payload = unknown,
  Result = unknown,
  Context extends HanaBusHandlerContext = HanaBusHandlerContext,
>(
  definition: HanaBusHandlerDefinition<Payload, Result, Context>,
): HanaBusHandlerDefinition<Payload, Result, Context> {
  return { ...definition };
}

export function requestBus<Result = unknown, Payload = unknown>(
  ctx: { bus?: Pick<HanaEventBus, 'request'> | null },
  type: string,
  payload?: Payload,
  options?: Record<string, unknown>,
): Promise<Result> {
  if (!ctx.bus || typeof ctx.bus.request !== 'function') {
    throw new Error('plugin bus request unavailable');
  }
  return ctx.bus.request<Result>(type, payload, options);
}

function pluginIdFromContext(ctx: { pluginId?: string | null }): string | null {
  return typeof ctx.pluginId === 'string' && ctx.pluginId.length > 0 ? ctx.pluginId : null;
}

function withOwnerPlugin<T extends Record<string, unknown>>(
  ctx: { pluginId?: string | null },
  input: T,
): T {
  const pluginId = pluginIdFromContext(ctx);
  if (!pluginId || input.ownerPluginId) return input;
  return { ...input, ownerPluginId: pluginId };
}

function withContextMetadata(
  ctx: { pluginId?: string | null },
  context: HanaSessionTurnContext | null | undefined,
): HanaSessionTurnContext | null | undefined {
  const pluginId = pluginIdFromContext(ctx);
  if (!pluginId) return context;
  if (!context) {
    return { metadata: { pluginId } };
  }
  return {
    ...context,
    metadata: {
      pluginId,
      ...(context.metadata || {}),
    },
  };
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeSessionTarget(target: HanaSessionTarget): Record<string, unknown> {
  if (typeof target === 'string') return { sessionPath: target };
  if (!target || typeof target !== 'object') return { sessionPath: target as unknown };

  const sessionId = textOrNull((target as any).sessionId);
  const sessionPath = textOrNull((target as any).sessionPath) || textOrNull((target as any).path);
  const legacySessionPath = textOrNull((target as any).legacySessionPath);
  if (!sessionId) {
    return sessionPath ? { sessionPath } : {};
  }

  const sessionRef: HanaSessionRef = {
    sessionId,
    ...(sessionPath ? { sessionPath } : {}),
    ...(legacySessionPath ? { legacySessionPath } : {}),
  };
  return {
    sessionId,
    ...(sessionPath ? { sessionPath } : {}),
    ...(legacySessionPath ? { legacySessionPath } : {}),
    sessionRef,
  };
}

function sessionRefFromTarget(target: HanaSessionTarget): HanaSessionRef | null {
  const payload = normalizeSessionTarget(target);
  return (payload.sessionRef as HanaSessionRef | undefined) || null;
}

export function createChatSurfaceCard(
  ctx: { pluginId?: string | null },
  target: HanaSessionTarget,
  options: HanaChatSurfaceCardOptions = {},
): HanaChatSurfaceCardDetails {
  const pluginId = pluginIdFromContext(ctx);
  if (!pluginId) {
    throw new Error('createChatSurfaceCard requires ctx.pluginId');
  }
  const payload = normalizeSessionTarget(target);
  const sessionId = textOrNull(payload.sessionId);
  const sessionPath = textOrNull(payload.sessionPath);
  if (!sessionId) {
    throw new Error('createChatSurfaceCard requires sessionId or sessionRef; sessionPath alone is legacy locator metadata');
  }
  const sessionRef: HanaSessionRef = {
    sessionId,
    ...(sessionPath ? { sessionPath } : {}),
  };
  return {
    type: 'chat.surface',
    pluginId,
    sessionId,
    sessionRef,
    ...(sessionPath ? { sessionPath } : {}),
    ...(options.title ? { title: options.title } : {}),
    description: options.description || 'Plugin private chat session.',
    mode: options.mode || 'transcript',
    ...(options.composer !== undefined ? { composer: options.composer } : {}),
    ...(options.aspectRatio ? { aspectRatio: options.aspectRatio } : {}),
  };
}

export function createSession(
  ctx: { pluginId?: string | null; bus?: Pick<HanaEventBus, 'request'> | null },
  input: HanaSessionCreateInput = {},
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'session:create', withOwnerPlugin(ctx, { ...input }), options);
}

export function getSession(
  ctx: { bus?: Pick<HanaEventBus, 'request'> | null },
  target: HanaSessionTarget,
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'session:get', normalizeSessionTarget(target), options);
}

export function listSessions(
  ctx: { bus?: Pick<HanaEventBus, 'request'> | null },
  filter: HanaSessionListFilter = {},
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'session:list', filter, options);
}

export function updateSession(
  ctx: { pluginId?: string | null; bus?: Pick<HanaEventBus, 'request'> | null },
  target: HanaSessionTarget,
  patch: HanaSessionUpdateInput,
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'session:update', {
    ...normalizeSessionTarget(target),
    ...withOwnerPlugin(ctx, { ...patch }),
  }, options);
}

export function sendSessionMessage(
  ctx: { pluginId?: string | null; bus?: Pick<HanaEventBus, 'request'> | null },
  target: HanaSessionTarget,
  input: HanaSessionSendInput,
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'session:send', {
    ...normalizeSessionTarget(target),
    ...input,
    context: withContextMetadata(ctx, input.context),
  }, options);
}

export function subscribeSessionEvents(
  ctx: { bus?: Pick<HanaEventBus, 'subscribe'> | null },
  target: HanaSessionTarget,
  handler: (event: unknown, meta: { sessionId: string | null; sessionPath: string | null; sessionRef: HanaSessionRef | null }) => void,
): () => void {
  if (!ctx.bus || typeof ctx.bus.subscribe !== 'function') {
    throw new Error('plugin bus subscribe unavailable');
  }
  const filter = normalizeSessionTarget(target);
  const targetRef = sessionRefFromTarget(target);
  return ctx.bus.subscribe((event, scopedSessionPath) => {
    const eventSessionId = event && typeof event === 'object' ? textOrNull((event as any).sessionId) : null;
    const sessionId = eventSessionId || targetRef?.sessionId || null;
    const sessionPath = scopedSessionPath || targetRef?.sessionPath || null;
    const sessionRef = sessionId ? {
      sessionId,
      ...(sessionPath ? { sessionPath } : {}),
      ...(targetRef?.legacySessionPath ? { legacySessionPath: targetRef.legacySessionPath } : {}),
    } : null;
    handler(event, { sessionId, sessionPath, sessionRef });
  }, filter);
}

export function listAgents(
  ctx: { bus?: Pick<HanaEventBus, 'request'> | null },
  filter: { ownerPluginId?: string; includePluginPrivate?: boolean } = {},
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'agent:list', filter, options);
}

export function getAgentProfile(
  ctx: { bus?: Pick<HanaEventBus, 'request'> | null },
  agentId: string,
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'agent:profile', { agentId }, options);
}

export function createAgent(
  ctx: { pluginId?: string | null; bus?: Pick<HanaEventBus, 'request'> | null },
  input: HanaAgentCreateInput,
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'agent:create', withOwnerPlugin(ctx, { ...input }), options);
}

export function updateAgent(
  ctx: { pluginId?: string | null; bus?: Pick<HanaEventBus, 'request'> | null },
  agentId: string,
  patch: HanaAgentUpdateInput,
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'agent:update', { agentId, ...withOwnerPlugin(ctx, { ...patch }) }, options);
}

export function sampleText(
  ctx: { pluginId?: string | null; bus?: Pick<HanaEventBus, 'request'> | null },
  input: HanaModelSampleInput,
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'model:sample-text', {
    ...input,
    ...(pluginIdFromContext(ctx) ? { pluginId: pluginIdFromContext(ctx) } : {}),
  }, options);
}

export function listMediaProviders(
  ctx: { bus?: Pick<HanaEventBus, 'request'> | null },
  filter: HanaMediaProviderFilter = {},
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'provider:media-providers', filter, options);
}

export function resolveMediaModel(
  ctx: { bus?: Pick<HanaEventBus, 'request'> | null },
  ref: HanaMediaModelRef,
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'provider:resolve-media-model', ref, options);
}

export function generateImage(
  ctx: { pluginId?: string | null; bus?: Pick<HanaEventBus, 'request'> | null },
  input: HanaGenerateImageInput,
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'media:generate-image', {
    ...input,
    ...(pluginIdFromContext(ctx) ? { pluginId: pluginIdFromContext(ctx) } : {}),
  }, options);
}

export function generateVideo(
  ctx: { pluginId?: string | null; bus?: Pick<HanaEventBus, 'request'> | null },
  input: HanaGenerateVideoInput,
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'media:generate-video', {
    ...input,
    ...(pluginIdFromContext(ctx) ? { pluginId: pluginIdFromContext(ctx) } : {}),
  }, options);
}

export function generateMedia(
  ctx: { pluginId?: string | null; bus?: Pick<HanaEventBus, 'request'> | null },
  input: HanaGenerateMediaInput,
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'media:generate', {
    ...input,
    ...(pluginIdFromContext(ctx) ? { pluginId: pluginIdFromContext(ctx) } : {}),
  }, options);
}

export function transcribeAudio(
  ctx: { pluginId?: string | null; bus?: Pick<HanaEventBus, 'request'> | null },
  input: HanaTranscribeAudioInput,
  options?: Record<string, unknown>,
): Promise<HanaTranscribeAudioResult> {
  return requestBus(ctx, 'media:transcribe-audio', {
    ...input,
    ...(pluginIdFromContext(ctx) ? { pluginId: pluginIdFromContext(ctx) } : {}),
  }, options).then(normalizeTranscribeAudioResult);
}

function normalizeTranscribeAudioResult(result: unknown): HanaTranscribeAudioResult {
  if (result && typeof result === 'object' && (result as any).ok === true
    && Object.prototype.hasOwnProperty.call(result, 'transcription')) {
    return result as HanaTranscribeAudioResult;
  }
  return { ok: true, transcription: result };
}

export function listUsageEntries(
  ctx: { bus?: Pick<HanaEventBus, 'request'> | null },
  filter: HanaUsageListFilter = {},
  options?: Record<string, unknown>,
): Promise<HanaUsageListResult> {
  return requestBus<HanaUsageListResult, HanaUsageListFilter>(ctx, 'usage:list', filter, options);
}

export function subscribeUsageEvents(
  ctx: { bus?: Pick<HanaEventBus, 'subscribe'> | null },
  handler: (entry: HanaUsageLedgerEntry, meta: HanaUsageEventMeta) => void,
): () => void {
  if (!ctx.bus || typeof ctx.bus.subscribe !== 'function') {
    throw new Error('plugin bus subscribe unavailable');
  }
  return ctx.bus.subscribe((event, sessionPath) => {
    if (!event || typeof event !== 'object') return;
    const typed = event as { type?: unknown; entry?: unknown };
    if (typed.type !== 'llm_usage') return;
    const entry = typed.entry as HanaUsageLedgerEntry;
    const entrySessionId =
      textOrNull((entry as any)?.attribution?.sessionId)
      || textOrNull((entry as any)?.source?.actor?.sessionId)
      || textOrNull((entry as any)?.source?.parent?.sessionId);
    const entrySessionPath =
      textOrNull((entry as any)?.attribution?.sessionPath)
      || textOrNull((entry as any)?.source?.actor?.sessionPath)
      || textOrNull((entry as any)?.source?.parent?.sessionPath)
      || textOrNull(sessionPath);
    handler(entry, {
      ...(entrySessionId ? { sessionId: entrySessionId } : {}),
      sessionPath: entrySessionPath,
      ...(entrySessionId ? {
        sessionRef: {
          sessionId: entrySessionId,
          ...(entrySessionPath ? { sessionPath: entrySessionPath } : {}),
        },
      } : {}),
    });
  }, { types: ['llm_usage'] });
}

export function registerTask(
  ctx: { bus?: Pick<HanaEventBus, 'request'> | null },
  input: HanaTaskRegisterInput,
): Promise<{ ok: true }> {
  return requestBus(ctx, 'task:register', input);
}

export function updateTask(
  ctx: { bus?: Pick<HanaEventBus, 'request'> | null },
  input: HanaTaskUpdateInput,
): Promise<{ ok: true; task: HanaTaskRecord }> {
  return requestBus(ctx, 'task:update', input);
}

export function completeTask(
  ctx: { bus?: Pick<HanaEventBus, 'request'> | null },
  taskId: string,
  result?: unknown,
): Promise<{ ok: true; task: HanaTaskRecord }> {
  return requestBus(ctx, 'task:complete', { taskId, result });
}

export function failTask(
  ctx: { bus?: Pick<HanaEventBus, 'request'> | null },
  taskId: string,
  error: unknown,
): Promise<{ ok: true; task: HanaTaskRecord }> {
  return requestBus(ctx, 'task:fail', { taskId, error });
}

export function cancelTask(
  ctx: { bus?: Pick<HanaEventBus, 'request'> | null },
  taskId: string,
  reason?: string,
): Promise<{ result: string; canceled: boolean }> {
  return requestBus(ctx, 'task:cancel', { taskId, reason });
}

export function scheduleTask(
  ctx: { bus?: Pick<HanaEventBus, 'request'> | null },
  input: HanaTaskScheduleInput,
): Promise<{ ok: true; schedule: HanaTaskSchedule }> {
  return requestBus(ctx, 'task:schedule', input);
}

export function unscheduleTask(
  ctx: { bus?: Pick<HanaEventBus, 'request'> | null },
  scheduleId: string,
): Promise<{ ok: true; removed: boolean }> {
  return requestBus(ctx, 'task:unschedule', { scheduleId });
}

export function sessionFileToMediaItem(file: HanaSessionFile): HanaSessionFileMediaItem {
  const fileId = firstText(file.fileId, file.id);
  if (!fileId) {
    throw new Error('SessionFile media item requires id or fileId');
  }

  const item: HanaSessionFileMediaItem = {
    type: 'session_file',
    fileId,
  };
  assignDefined(item, 'sessionId', file.sessionId);
  assignDefined(item, 'sessionPath', file.sessionPath);
  assignDefined(item, 'filePath', file.filePath);
  assignDefined(item, 'label', firstText(file.label, file.displayName, file.filename));
  assignDefined(item, 'mime', file.mime);
  assignDefined(item, 'size', file.size);
  assignDefined(item, 'kind', file.kind);
  return item;
}

type HanaMediaInput = HanaSessionFile | HanaSessionFileMediaItem | HanaStagedSessionFile;

export function createMediaDetails(items: HanaMediaInput[]): HanaMediaDetails {
  return {
    media: {
      items: items.map(normalizeMediaItem),
    },
  };
}

export function defineExtension<Pi = unknown>(factory: HanaExtensionFactory<Pi>): HanaExtensionFactory<Pi> {
  return factory;
}

export function definePlugin(lifecycle: HanaPluginLifecycle): new () => HanaPluginInstance {
  return class DefinedHanaPlugin implements HanaPluginInstance {
    ctx!: HanaPluginContext;
    register!: (disposable: HanaPluginDisposable) => void;

    async onload(): Promise<void> {
      await lifecycle.onload?.(this.ctx, { register: this.register });
    }

    async onunload(): Promise<void> {
      await lifecycle.onunload?.(this.ctx);
    }
  };
}

function normalizeMediaItem(input: HanaMediaInput): HanaSessionFileMediaItem {
  if (isRecord(input) && isRecord(input.mediaItem)) {
    return normalizeSessionFileMediaItem(input.mediaItem);
  }
  if (isRecord(input) && input.type === 'session_file') {
    return normalizeSessionFileMediaItem(input);
  }
  if (isRecord(input)) {
    return sessionFileToMediaItem(input);
  }
  throw new Error('media details item must be a SessionFile, staged file, or session_file media item');
}

function normalizeSessionFileMediaItem(input: Record<string, unknown>): HanaSessionFileMediaItem {
  if (input.type !== 'session_file') {
    throw new Error('media details item must be a session_file media item');
  }
  const fileId = firstText(input.fileId);
  if (!fileId) {
    throw new Error('SessionFile media item requires fileId');
  }
  return {
    ...input,
    type: 'session_file',
    fileId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function assignDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined && value !== null) {
    target[key] = value;
  }
}
