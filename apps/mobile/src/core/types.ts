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
