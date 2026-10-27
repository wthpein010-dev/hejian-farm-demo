export interface CatalogItem { id: string; title: string; description: string; category: 'supplies' | 'gifts'; cost: number; limit: number; art: string; }
export interface Coupon { id: string; title: string; min: number; off: number; used: boolean; }
export interface Reward { points?: number; feed?: number; fertilizer?: number; tools?: number; coupon?: object; }
export interface Task { id: string; title: string; description: string; progress: number; target: number; claimed: boolean; ready: boolean; reward: Reward; }
export interface Snapshot {
  serverTime: number; revision: number; environment: 'development' | 'production';
  profile: { id: string; displayName: string };
  wallet: { points: number; feed: number };
  system: { cart: Record<string, number>; coupons: Coupon[]; inventory: Record<string, number>; daily: { bought: Record<string, number> }; purchases: Array<{ id: string; day: string; total: number; count: number }> };
  catalog: CatalogItem[]; tasks: Task[]; achievements: Task[];
  signIn: { todayClaimed: boolean; streak: number; nextIndex: number; rewards: Array<{ day: number; label: string }> };
  season: { count: number; total: number; ready: boolean; claimed: boolean };
  level: { level: number; label: string; xp: number; progress: number; next: number | null };
  farm: { plots: Array<{ id: string; name: string; status: string }>; animals: Array<{ id: string; name: string; status: string }> };
  capabilities: Record<string, boolean>;
}
export interface PrivacyReport {
  profile: { id: string; displayName: string };
  createdAt: number; updatedAt: number; deletionSupported: boolean;
  dataCategories: Array<{ id: string; title: string; description: string }>;
}
export type FarmRegistryKind = 'plots' | 'animals';
export type FarmRecordStatus = 'planned' | 'growing' | 'ready' | 'archived';
export interface FarmRecord {
  id: string; ownerId: string; environment: 'development' | 'production'; kind: 'plot' | 'animal';
  name: string; unitLabel: string; cycleRef: string; status: FarmRecordStatus;
  startedAt: number | null; expectedHarvestAt: number | null; observedAt: number;
  measurements: { areaM2?: number; moisturePercent?: number; weightKg?: number; headCount?: number };
  version: number; createdAt: number; updatedAt: number;
}
export interface FarmRegistryPage {
  recordFormat: 1; ownerId: string; environment: 'development' | 'production'; kind: FarmRegistryKind;
  items: FarmRecord[]; nextCursor: string | null; serverTime: number;
}
export interface FarmRecordEvent { version: number; recordedAt: number; source: string; record: FarmRecord; }
export interface FarmRegistryDetail {
  recordFormat: 1; ownerId: string; environment: 'development' | 'production'; record: FarmRecord;
  events: FarmRecordEvent[]; nextBeforeVersion: number | null; serverTime: number;
}
export type ResourceKey = 'feed' | 'fertilizer' | 'tools' | 'seedPacks' | 'decorations';
export interface Exchange {
  id: string; day: string;
  items: Array<{ sku: string; title: string; art: string; quantity: number; unitPoints: number; linePoints: number; grant: Partial<Record<ResourceKey, number>> }>;
  count: number; subtotal: number; discount: number; total: number; couponId: string | null;
  received: Partial<Record<ResourceKey, number>>;
}
export interface ExchangePage {
  exchangeFormat: 1; ownerId: string; environment: 'development' | 'production'; serverTime: number;
  items: Exchange[]; nextCursor: string | null;
}
export interface ExchangeDetail {
  exchangeFormat: 1; ownerId: string; environment: 'development' | 'production'; serverTime: number; exchange: Exchange;
}
export type FriendAction = 'enable' | 'disable' | 'request' | 'accept' | 'decline' | 'cancel' | 'remove' | 'block' | 'unblock';
export type FriendCommand = { action: 'enable' | 'disable' } | { action: 'request'; code: string } | { action: 'accept' | 'decline' | 'cancel' | 'remove' | 'block' | 'unblock'; peerId: string };
export interface FriendEntry { peerId: string; alias: string; createdAt: number; }
export interface FriendsView {
  friendsFormat: 1; ownerId: string; environment: 'development' | 'production'; serverTime: number; version: number;
  available: boolean; enabled: boolean; profile: { code: string; alias: string } | null;
  friends: FriendEntry[]; incoming: FriendEntry[]; outgoing: FriendEntry[]; blocked: FriendEntry[];
}
export interface FriendCommandReceipt {
  friendsFormat: 1; ownerId: string; environment: 'development' | 'production'; operationKey: string; action: FriendAction;
  outcome: 'applied' | 'refused'; code: string; completedAt: number;
}
export type ForumCircle = 'harvest' | 'questions' | 'chat';
export type ForumReason = 'spam' | 'abuse' | 'privacy' | 'misinformation' | 'other';
export type ForumState = 'pending' | 'published' | 'rejected' | 'hidden' | 'withdrawn';
export interface ForumContent {
  id: string; kind: 'post' | 'comment'; parentId: string | null; circle: ForumCircle;
  author: { peerId: string; alias: string; self: boolean }; title: string; body: string;
  state: ForumState; version: number; createdAt: number; updatedAt: number; publishedAt: number | null; reasonCode: string | null;
}
export interface ForumScope { forumFormat: 1; ownerId: string; environment: 'development' | 'production'; serverTime: number; }
export interface ForumStatus extends ForumScope { available: boolean; canPost: boolean; alias: string | null; limits: { posts: number; comments: number; reports: number; active: number }; usage: { posts: number; comments: number; reports: number }; }
export interface ForumPage extends ForumScope { scope: 'public' | 'mine'; circle: 'all' | ForumCircle; items: ForumContent[]; nextCursor: string | null; }
export interface ForumDetail extends ForumScope { post: ForumContent; comments: ForumContent[]; nextCursor: string | null; }
export interface ForumReport { id: string; contentId: string; kind: 'post' | 'comment'; reason: ForumReason; status: 'open' | 'resolved'; resolution: null | 'dismissed' | 'hidden' | 'withdrawn'; version: number; createdAt: number; resolvedAt: number | null; }
export interface ForumReports extends ForumScope { items: ForumReport[]; nextCursor: string | null; }
export type ForumCommand = { action: 'submit-post'; circle: ForumCircle; title: string; body: string } | { action: 'submit-comment'; postId: string; expectedVersion: number; body: string } | { action: 'withdraw' | 'block-author'; contentId: string; expectedVersion: number } | { action: 'report'; contentId: string; expectedVersion: number; reason: ForumReason };
export interface ForumReceipt { forumFormat: 1; ownerId: string; environment: 'development' | 'production'; operationKey: string; action: ForumCommand['action']; outcome: 'applied' | 'refused'; code: string; contentId: string | null; completedAt: number; }
export type PlantingAudience = 'customer' | 'staff';
export type PlantingState = 'requested' | 'accepted' | 'assigned' | 'working' | 'completed' | 'cancelled';
export type PlantingAction = 'request' | 'cancel' | 'accept' | 'assign' | 'start' | 'complete' | 'cancel-work';
export interface PlantingScope { plantingFormat: 1; ownerId: string; environment: 'development' | 'production'; serverTime: number; }
export interface PlantingStatus extends PlantingScope { available: boolean; hasStaffAccess: boolean; }
export interface PlantingRecord extends PlantingScope { recordId: string; recordVersion: number; enabled: boolean; notBefore: number | null; currentOrderId: string | null; }
export interface PlantingOrder { id: string; recordId: string; cycleRef: string; name: string; unitLabel: string; status: PlantingState; version: number; recordVersion: number; notBefore: number; createdAt: number; updatedAt: number; startedAt: number | null; completedAt: number | null; assigneeRef: string | null; }
export interface PlantingPage extends PlantingScope { items: PlantingOrder[]; nextCursor: string | null; }
export interface PlantingDetail extends PlantingScope { order: PlantingOrder; events: Array<{ version: number; action: PlantingAction; recordedAt: number; occurredAt: number; actorRef: string }>; candidates: Array<{ ref: string; label: string }>; permissions: { canCancel: boolean; canAccept: boolean; canAssign: boolean; canStart: boolean; canComplete: boolean; canCancelWork: boolean }; }
export type PlantingCommand = { action: 'request'; recordId: string; expectedRecordVersion: number } | { action: 'cancel' | 'accept' | 'start'; orderId: string; expectedOrderVersion: number } | { action: 'assign'; orderId: string; expectedOrderVersion: number; assigneeRef: string } | { action: 'complete'; orderId: string; expectedOrderVersion: number; expectedRecordVersion: number; performedAt: number } | { action: 'cancel-work'; orderId: string; expectedOrderVersion: number; stoppedAt: number; reason: 'farm-confirmed-stop' };
export interface PlantingReceipt { plantingFormat: 1; ownerId: string; environment: 'development' | 'production'; operationKey: string; action: PlantingAction; outcome: 'applied' | 'refused'; code: string; orderId: string | null; completedAt: number; }

export type RecoveryDiscovery = 'unknown' | 'checking' | 'clear' | 'open' | 'error';
export type RecoveryStage = 'prepare-unknown' | 'prepared' | 'execute-unknown' | 'receipt-review' | 'ack-unknown' | 'abandon-unknown' | 'quarantined';
export interface RecoveryIntent { id: string; audience: PlantingAudience; command: PlantingCommand; operationKey: string; prepareEpoch: string; prepareVersion: number; phase: 'prepared' | 'settled' | 'abandoned' | 'quarantined'; version: number; createdAt: number; updatedAt: number; closedAt: number | null; receipt: PlantingReceipt | null; }
