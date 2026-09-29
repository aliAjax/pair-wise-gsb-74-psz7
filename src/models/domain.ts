export type Platform = 'web' | 'ios' | 'android' | 'server' | 'miniprogram'
export type EventStatus = 'draft' | 'reviewing' | 'approved' | 'published' | 'deprecated' | 'retired'
export type PropertyType = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'enum'
export type ReleaseStatus =
  | 'draft'
  | 'blocked'
  | 'reviewing'
  | 'approved'
  | 'published'
  | 'rolled_back'
export type Severity = 'critical' | 'high' | 'medium' | 'low'

export interface EventProperty {
  id: string
  eventId: string
  name: string
  displayName: string
  type: PropertyType
  required: boolean
  description: string
  enumValues: string[]
  owner: string
  synonyms: string[]
  platforms: Platform[]
  lineageSourceId?: string
  deletedAt?: string
}

export interface PlatformRule {
  id: string
  eventId: string
  platform: Platform
  enabled: boolean
  trigger: string
  owner: string
  requiredPropertyIds: string[]
  note: string
}

export interface EventDefinition {
  id: string
  key: string
  displayName: string
  category: string
  description: string
  trigger: string
  status: EventStatus
  version: string
  owner: string
  properties: EventProperty[]
  platformRules: PlatformRule[]
  scenarioIds: string[]
  downstreamDependencyIds: string[]
  updatedAt: string
}

export interface BusinessScenario {
  id: string
  name: string
  domain: string
  owner: string
  platform: Platform
  eventIds: string[]
  status: 'active' | 'migrating' | 'retired'
}

export interface DownstreamDependency {
  id: string
  name: string
  type: 'dashboard' | 'alert' | 'model' | 'dataset' | 'experiment'
  owner: string
  environment: 'production' | 'staging' | 'analysis'
  eventIds: string[]
  propertyRefs: Array<{ eventId: string; propertyId: string }>
  status: 'active' | 'migration_required' | 'migrated' | 'disabled'
}

export interface EventVersionSnapshot {
  id: string
  eventId: string
  version: string
  properties: EventProperty[]
  createdAt: string
  status: 'published' | 'superseded'
}

export interface ContractDifference {
  eventId: string
  eventKey: string
  addedProperties: string[]
  removedProperties: string[]
  requiredChanges: string[]
  typeChanges: string[]
  enumChanges: string[]
}

export interface MigrationConfirmation {
  id: string
  dependencyId: string
  version: string
  status: 'pending' | 'confirmed' | 'rejected'
  reviewer: string
  note: string
  confirmedAt?: string
}

export interface ReleaseApproval {
  id: string
  role: 'data' | 'product' | 'client' | 'qa'
  actor: string
  status: 'pending' | 'approved' | 'rejected'
  comment: string
  createdAt?: string
}

export interface ReleaseBlocker {
  id: string
  kind: 'deleted_property_referenced' | 'critical_validation'
  severity: Severity
  title: string
  detail: string
  /** 受影响的下游依赖 ID，用于在待处理区指出依赖 */
  dependencyIds: string[]
  /** 涉及的事件 ID */
  eventId?: string
  /** 涉及的属性 ID，用于按冻结内容恢复旧字段 */
  propertyId?: string
  propertyName?: string
  /** 是否可以直接按冻结快照恢复字段 */
  resolvableByRestore: boolean
  suggestion: string
}

export interface FrozenDependency {
  id: string
  name: string
  type: DownstreamDependency['type']
  owner: string
  environment: DownstreamDependency['environment']
  eventIds: string[]
  propertyRefs: Array<{ eventId: string; propertyId: string }>
  status: DownstreamDependency['status']
}

export interface ReleaseFreeze {
  frozenAt: string
  /** 创建候选时参与发布的事件完整快照（含属性、平台规则） */
  events: EventDefinition[]
  /** 创建候选时的下游依赖完整状态（含字段引用） */
  dependencies: FrozenDependency[]
  /** 发布时引用的上一版本号，回滚后恢复为当前版本 */
  previousVersion: string
}

export type ReleaseTimelinePhase =
  | 'created'
  | 'blocked'
  | 'unblocked'
  | 'migration_confirmed'
  | 'approved'
  | 'rejected'
  | 'published'
  | 'rolled_back'
  | 'rollback_verified'
  | 'property_restored'

export interface ReleaseTimelineEntry {
  id: string
  phase: ReleaseTimelinePhase
  actor: string
  detail: string
  at: string
}

export interface ReleaseCandidate {
  id: string
  version: string
  title: string
  status: ReleaseStatus
  eventIds: string[]
  affectedDependencyIds: string[]
  differences: ContractDifference[]
  migrationConfirmations: MigrationConfirmation[]
  approvals: ReleaseApproval[]
  /** 创建候选时冻结的事件、属性与依赖关系，回滚依据 */
  freeze?: ReleaseFreeze
  /** 创建候选时识别的阻断项快照 */
  blockers: ReleaseBlocker[]
  /** 发布、阻断解除与回滚经过 */
  timeline: ReleaseTimelineEntry[]
  createdAt: string
  publishedAt?: string
  /** 发布时写入的基线快照 ID，回滚时移除 */
  publishedBaselineIds?: string[]
}

export interface DeprecationPlan {
  id: string
  eventId: string
  replacementEventId?: string
  reason: string
  owner: string
  stopCollectAt: string
  retireAt: string
  status: 'planned' | 'announced' | 'stopped' | 'retired' | 'cancelled'
  migrationNote: string
}

export interface RollbackRecord {
  id: string
  releaseId: string
  version: string
  reason: string
  operator: string
  scope: string
  createdAt: string
  status: 'executed' | 'verified'
  evidence: string
  /** 按冻结内容实际恢复的对象统计 */
  restoreSummary?: {
    eventsRestored: number
    propertiesRestored: number
    dependenciesRestored: number
    baselinesRevoked: number
  }
}

export interface AuditEvent {
  id: string
  entityType: string
  entityId: string
  action: string
  actor: string
  detail: string
  createdAt: string
}

export interface GovernanceState {
  events: EventDefinition[]
  scenarios: BusinessScenario[]
  dependencies: DownstreamDependency[]
  baselines: EventVersionSnapshot[]
  releases: ReleaseCandidate[]
  deprecations: DeprecationPlan[]
  rollbacks: RollbackRecord[]
  audit: AuditEvent[]
  currentVersion: string
}

export interface ValidationIssue {
  id: string
  kind:
    | 'duplicate_event'
    | 'synonym_property'
    | 'naming_violation'
    | 'type_change'
    | 'deleted_property_referenced'
    | 'required_mismatch'
  severity: Severity
  title: string
  detail: string
  entityId: string
  suggestion: string
}

export interface SampleValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}
