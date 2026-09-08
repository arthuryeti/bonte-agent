import { Pool } from "pg";

export interface WorkflowRecord<T = Record<string, unknown>> {
  id: string;
  kind: string;
  workspaceId: string;
  data: T;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowStore {
  get<T = Record<string, unknown>>(scope: string, kind: string, id: string): Promise<WorkflowRecord<T> | null>;
  put<T>(scope: string, kind: string, id: string, data: T): Promise<WorkflowRecord<T>>;
  create<T>(scope: string, kind: string, id: string, data: T): Promise<boolean>;
  compareAndSet<T>(scope: string, kind: string, id: string, version: number, data: T): Promise<boolean>;
  transitionWithRecords<T>(scope:string,kind:string,id:string,version:number,data:T,records:Array<{kind:string;id:string;data:unknown}>):Promise<boolean>;
  list<T = Record<string, unknown>>(scope: string, kind: string, limit?: number): Promise<WorkflowRecord<T>[]>;
  scan<T = Record<string, unknown>>(kind: string, limit?: number, after?: { workspaceId: string; id: string }, workspaceId?: string): Promise<WorkflowRecord<T>[]>;
  remove(scope: string, kind: string, id: string): Promise<boolean>;
  due<T = Record<string, unknown>>(kind: string, now: string, limit?: number): Promise<WorkflowRecord<T>[]>;
  expired<T = Record<string, unknown>>(kind: string, now: string, limit?: number, after?: { expiresAt: string; workspaceId: string; id: string }): Promise<WorkflowRecord<T>[]>;
  close(): Promise<void>;
}

function validate(scope: string, kind: string, id?: string): void {
  if (!scope || scope.length > 256 || !/^[a-z][a-z0-9_-]{0,63}$/.test(kind) ||
      (id !== undefined && (!id || id.length > 256))) throw new Error("Invalid workflow record identity.");
}

function record<T>(row: Record<string, unknown>): WorkflowRecord<T> {
  return { id: String(row.id), kind: String(row.kind), workspaceId: String(row.workspace_id),
    data: row.data as T, version: Number(row.version),
    createdAt: new Date(row.created_at as string).toISOString(), updatedAt: new Date(row.updated_at as string).toISOString() };
}

export class PostgresWorkflowStore implements WorkflowStore {
  constructor(private readonly pool: Pool) {}

  async connect(): Promise<void> {
    // Schema changes are committed migrations, never opportunistic DDL in a tool.
    await this.pool.query("SELECT workspace_id, kind, id, data, version FROM workflow_records LIMIT 0");
  }
  async get<T>(scope: string, kind: string, id: string): Promise<WorkflowRecord<T> | null> {
    validate(scope, kind, id);
    const { rows } = await this.pool.query("SELECT * FROM workflow_records WHERE workspace_id=$1 AND kind=$2 AND id=$3", [scope, kind, id]);
    return rows[0] ? record<T>(rows[0]) : null;
  }
  async put<T>(scope: string, kind: string, id: string, data: T): Promise<WorkflowRecord<T>> {
    validate(scope, kind, id);
    const { rows } = await this.pool.query(`INSERT INTO workflow_records(workspace_id,kind,id,data) VALUES($1,$2,$3,$4::jsonb)
      ON CONFLICT(workspace_id,kind,id) DO UPDATE SET data=EXCLUDED.data,version=workflow_records.version+1,updated_at=now() RETURNING *`, [scope, kind, id, JSON.stringify(data)]);
    return record<T>(rows[0]);
  }
  async create<T>(scope: string, kind: string, id: string, data: T): Promise<boolean> {
    validate(scope, kind, id);
    const result = await this.pool.query("INSERT INTO workflow_records(workspace_id,kind,id,data) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING", [scope, kind, id, JSON.stringify(data)]);
    return result.rowCount === 1;
  }
  async compareAndSet<T>(scope: string, kind: string, id: string, version: number, data: T): Promise<boolean> {
    validate(scope, kind, id);
    const result = await this.pool.query("UPDATE workflow_records SET data=$5::jsonb,version=version+1,updated_at=now() WHERE workspace_id=$1 AND kind=$2 AND id=$3 AND version=$4", [scope,kind,id,version,JSON.stringify(data)]);
    return result.rowCount === 1;
  }
  async transitionWithRecords<T>(scope:string,kind:string,id:string,version:number,data:T,records:Array<{kind:string;id:string;data:unknown}>):Promise<boolean>{
    validate(scope,kind,id);for(const row of records)validate(scope,row.kind,row.id);
    const client=await this.pool.connect();
    try{await client.query("BEGIN");const changed=await client.query("UPDATE workflow_records SET data=$5::jsonb,version=version+1,updated_at=now() WHERE workspace_id=$1 AND kind=$2 AND id=$3 AND version=$4",[scope,kind,id,version,JSON.stringify(data)]);
      if(changed.rowCount!==1){await client.query("ROLLBACK");return false;}
      for(const row of records)await client.query("INSERT INTO workflow_records(workspace_id,kind,id,data) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING",[scope,row.kind,row.id,JSON.stringify(row.data)]);
      await client.query("COMMIT");return true;
    }catch(error){await client.query("ROLLBACK").catch(()=>{});throw error;}finally{client.release();}
  }
  async list<T>(scope: string, kind: string, limit = 100): Promise<WorkflowRecord<T>[]> {
    validate(scope,kind);
    const { rows } = await this.pool.query("SELECT * FROM workflow_records WHERE workspace_id=$1 AND kind=$2 ORDER BY updated_at DESC,id LIMIT $3", [scope,kind,Math.max(1,Math.min(10000,Math.floor(limit)))]);
    return rows.map(row => record<T>(row));
  }
  async scan<T>(kind: string, limit = 500, after?: { workspaceId: string; id: string }, workspaceId?: string): Promise<WorkflowRecord<T>[]> {
    const n = Math.max(1, Math.min(1000, Math.floor(limit)));
    if (workspaceId) {
      validate(workspaceId, kind);
      const { rows } = after
        ? await this.pool.query("SELECT * FROM workflow_records WHERE kind=$1 AND workspace_id=$2 AND id>$3 ORDER BY id LIMIT $4", [kind, workspaceId, after.id, n])
        : await this.pool.query("SELECT * FROM workflow_records WHERE kind=$1 AND workspace_id=$2 ORDER BY id LIMIT $3", [kind, workspaceId, n]);
      return rows.map(row => record<T>(row));
    }
    validate("worker", kind);
    const { rows } = after
      ? await this.pool.query("SELECT * FROM workflow_records WHERE kind=$1 AND (workspace_id,id)>($2,$3) ORDER BY workspace_id,id LIMIT $4", [kind, after.workspaceId, after.id, n])
      : await this.pool.query("SELECT * FROM workflow_records WHERE kind=$1 ORDER BY workspace_id,id LIMIT $2", [kind, n]);
    return rows.map(row => record<T>(row));
  }
  async remove(scope: string, kind: string, id: string): Promise<boolean> {
    validate(scope,kind,id);
    const result = await this.pool.query("DELETE FROM workflow_records WHERE workspace_id=$1 AND kind=$2 AND id=$3", [scope,kind,id]);
    return result.rowCount === 1;
  }
  async due<T>(kind: string, now: string, limit = 100): Promise<WorkflowRecord<T>[]> {
    validate("worker",kind);
    // ISO UTC timestamps are produced by our scheduler, not supplied to SQL casts.
    const { rows } = await this.pool.query(`SELECT * FROM workflow_records WHERE kind=$1 AND data->>'state'='scheduled'
      AND data->>'nextRunAt'<=$2 ORDER BY data->>'nextRunAt',id LIMIT $3`, [kind,now,Math.max(1,Math.min(1000,limit))]);
    return rows.map(row => record<T>(row));
  }
  async close(): Promise<void> { await this.pool.end(); }
  async expired<T>(kind:string,now:string,limit=100,after?:{expiresAt:string;workspaceId:string;id:string}):Promise<WorkflowRecord<T>[]> {
    validate("worker",kind);
    const n=Math.max(1,Math.min(limit,1000));
    const {rows}=after
      ? await this.pool.query("SELECT * FROM workflow_records WHERE kind=$1 AND data->>'expiresAt'<=$2 AND (data->>'expiresAt',workspace_id,id)>($3,$4,$5) ORDER BY data->>'expiresAt',workspace_id,id LIMIT $6",[kind,now,after.expiresAt,after.workspaceId,after.id,n])
      : await this.pool.query("SELECT * FROM workflow_records WHERE kind=$1 AND data->>'expiresAt'<=$2 ORDER BY data->>'expiresAt',workspace_id,id LIMIT $3",[kind,now,n]);
    return rows.map(r=>record<T>(r));
  }
}

/** Explicit test storage. Runtime never silently falls back to memory. */
export class MemoryWorkflowStore implements WorkflowStore {
  private records = new Map<string, WorkflowRecord<unknown>>();
  private key(scope: string,kind: string,id: string) { validate(scope,kind,id); return JSON.stringify([scope,kind,id]); }
  async get<T>(scope: string,kind: string,id: string): Promise<WorkflowRecord<T>|null> {
    return structuredClone(this.records.get(this.key(scope,kind,id)) ?? null) as WorkflowRecord<T>|null;
  }
  async put<T>(scope: string,kind: string,id: string,data:T): Promise<WorkflowRecord<T>> {
    const key=this.key(scope,kind,id); const old=this.records.get(key); const now=new Date().toISOString();
    const row={id,kind,workspaceId:scope,data:structuredClone(data),version:(old?.version??0)+1,createdAt:old?.createdAt??now,updatedAt:now};
    this.records.set(key,row); return structuredClone(row);
  }
  async create<T>(scope:string,kind:string,id:string,data:T):Promise<boolean> {
    const key=this.key(scope,kind,id); if(this.records.has(key))return false;
    // Synchronous map mutation before awaiting keeps create atomic in the test adapter.
    const now=new Date().toISOString();this.records.set(key,{id,kind,workspaceId:scope,data:structuredClone(data),version:1,createdAt:now,updatedAt:now});return true;
  }
  async compareAndSet<T>(scope:string,kind:string,id:string,version:number,data:T):Promise<boolean> {
    const key=this.key(scope,kind,id);const row=this.records.get(key);if(!row||row.version!==version)return false;
    this.records.set(key,{...row,data:structuredClone(data),version:version+1,updatedAt:new Date().toISOString()});return true;
  }
  async transitionWithRecords<T>(scope:string,kind:string,id:string,version:number,data:T,records:Array<{kind:string;id:string;data:unknown}>):Promise<boolean>{
    const key=this.key(scope,kind,id);const row=this.records.get(key);if(!row||row.version!==version)return false;
    const prepared=records.map(r=>({key:this.key(scope,r.kind,r.id),kind:r.kind,id:r.id,data:structuredClone(r.data)}));const now=new Date().toISOString();
    this.records.set(key,{...row,data:structuredClone(data),version:version+1,updatedAt:now});
    for(const item of prepared)if(!this.records.has(item.key))this.records.set(item.key,{workspaceId:scope,kind:item.kind,id:item.id,data:item.data,version:1,createdAt:now,updatedAt:now});return true;
  }
  async list<T>(scope:string,kind:string,limit=100):Promise<WorkflowRecord<T>[]> {
    validate(scope,kind);return structuredClone([...this.records.values()].filter(r=>r.workspaceId===scope&&r.kind===kind).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id)).slice(0,limit)) as WorkflowRecord<T>[];
  }
  async scan<T>(kind:string,limit=500,after?:{workspaceId:string;id:string},workspaceId?:string):Promise<WorkflowRecord<T>[]>{
    validate(workspaceId ?? "worker", kind);
    const n=Math.max(1,Math.min(1000,Math.floor(limit)));
    const rows=[...this.records.values()].filter(r=>r.kind===kind&&(!workspaceId||r.workspaceId===workspaceId))
      .sort((a,b)=>a.workspaceId.localeCompare(b.workspaceId)||a.id.localeCompare(b.id));
    const newer=after
      ? workspaceId
        ? rows.filter(r=>r.id>after.id)
        : rows.filter(r=>r.workspaceId>after.workspaceId||(r.workspaceId===after.workspaceId&&r.id>after.id))
      : rows;
    return structuredClone(newer.slice(0, n)) as WorkflowRecord<T>[];
  }
  async remove(scope:string,kind:string,id:string):Promise<boolean>{return this.records.delete(this.key(scope,kind,id));}
  async due<T>(kind:string,now:string,limit=100):Promise<WorkflowRecord<T>[]>{
    return structuredClone([...this.records.values()].filter(r=>{const d=r.data as Record<string,unknown>;return r.kind===kind&&d.state==="scheduled"&&typeof d.nextRunAt==="string"&&d.nextRunAt<=now;}).slice(0,limit)) as WorkflowRecord<T>[];
  }
  async close():Promise<void>{}
  async expired<T>(kind:string,now:string,limit=100,after?:{expiresAt:string;workspaceId:string;id:string}):Promise<WorkflowRecord<T>[]> {
    const n=Math.max(1,Math.min(1000,Math.floor(limit)));
    const rows=structuredClone([...this.records.values()].filter(r=>{
      const d=r.data as Record<string,unknown>;
      return r.kind===kind&&typeof d.expiresAt==="string"&&d.expiresAt<=now;
    }).sort((a,b)=>{
      const ae=String((a.data as Record<string,unknown>).expiresAt);
      const be=String((b.data as Record<string,unknown>).expiresAt);
      return ae.localeCompare(be)||a.workspaceId.localeCompare(b.workspaceId)||a.id.localeCompare(b.id);
    })) as WorkflowRecord<T>[];
    const newer=after?rows.filter(r=>{
      const exp=String((r.data as Record<string,unknown>).expiresAt);
      return exp>after.expiresAt||(exp===after.expiresAt&&(r.workspaceId>after.workspaceId||(r.workspaceId===after.workspaceId&&r.id>after.id)));
    }):rows;
    return newer.slice(0,n);
  }
}

let singleton: WorkflowStore | undefined;
export function setWorkflowStore(store: WorkflowStore): void { singleton=store; }
export function getWorkflowStore(): WorkflowStore {
  if(!singleton) throw new Error("Workflow storage is not initialized. Apply database migrations and start the gateway.");
  return singleton;
}
export async function initializeWorkflowStore():Promise<WorkflowStore>{
  if(singleton)return singleton;
  if(!process.env.DATABASE_URL&&!process.env.DATABASE_HOST)throw new Error("DATABASE_URL or DATABASE_HOST is required for durable workflows.");
  const pool=new Pool({connectionString:process.env.DATABASE_URL||undefined,host:process.env.DATABASE_HOST||undefined,
    port:Number(process.env.DATABASE_PORT||5432),database:process.env.DATABASE_NAME||undefined,user:process.env.DATABASE_USER||undefined,password:process.env.DATABASE_PASSWORD||undefined,
    ssl:process.env.DATABASE_SSL==="true"?{rejectUnauthorized:process.env.DATABASE_SSL_REJECT_UNAUTHORIZED!=="false"}:undefined,max:5,connectionTimeoutMillis:10000});
  const store=new PostgresWorkflowStore(pool);
  try{await store.connect();}catch(error){await store.close();throw error;}
  singleton=store;return store;
}
