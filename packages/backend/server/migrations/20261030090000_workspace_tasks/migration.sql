-- CreateTable
CREATE TABLE "workspace_tasks" (
    "workspace_id" VARCHAR NOT NULL,
    "doc_id" VARCHAR NOT NULL,
    "block_id" VARCHAR NOT NULL,
    "text" TEXT NOT NULL,
    "refs" JSONB NOT NULL DEFAULT '[]',
    "heading" TEXT,
    "order" INTEGER NOT NULL,
    "checked" BOOLEAN NOT NULL DEFAULT false,
    "due" VARCHAR(10),
    "priority" SMALLINT,
    "completed_at" BIGINT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_tasks_pkey" PRIMARY KEY ("workspace_id","doc_id","block_id")
);

-- CreateTable
CREATE TABLE "workspace_task_states" (
    "workspace_id" VARCHAR NOT NULL,
    "extractor_version" INTEGER NOT NULL DEFAULT 0,
    "revision" BIGINT NOT NULL DEFAULT 0,
    "backfilled_at" TIMESTAMPTZ(3),

    CONSTRAINT "workspace_task_states_pkey" PRIMARY KEY ("workspace_id")
);

-- CreateIndex
CREATE INDEX "workspace_tasks_workspace_id_idx" ON "workspace_tasks"("workspace_id");

-- AddForeignKey
ALTER TABLE "workspace_tasks" ADD CONSTRAINT "workspace_tasks_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_task_states" ADD CONSTRAINT "workspace_task_states_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
