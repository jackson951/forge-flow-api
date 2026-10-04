-- Part 27: due-schedule claim: ORDER BY "nextRunAt", id read from the index. With (active, nextRunAt)
-- alone every batch re-sorted all schedules due at the same instant (10 000 → 194/s).
DROP INDEX "WorkflowSchedule_active_nextRunAt_idx";
CREATE INDEX "WorkflowSchedule_active_nextRunAt_id_idx" ON "WorkflowSchedule"("active", "nextRunAt", "id");
