-- Hand-written integrity rules that Prisma's schema language cannot express.
-- See docs/DATABASE.md. Never apply the schema with `prisma db push` — it would skip this file.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ─────────────── Group memberships: [joinedAt, leftAt) never overlap per member ───────────────
ALTER TABLE "GroupMembership"
  ADD CONSTRAINT "GroupMembership_range_check"
    CHECK ("leftAt" IS NULL OR "leftAt" > "joinedAt"),
  ADD CONSTRAINT "GroupMembership_end_reason_check"
    CHECK (("leftAt" IS NULL) = ("endReason" IS NULL)),
  ADD CONSTRAINT "GroupMembership_no_overlap"
    EXCLUDE USING gist ("memberId" WITH =, tstzrange("joinedAt", "leftAt", '[)') WITH &&);

-- ─────────────── Card assignments: one holder per card, one card per member, at any instant ───────────────
ALTER TABLE "CardAssignment"
  ADD CONSTRAINT "CardAssignment_range_check"
    CHECK ("endedAt" IS NULL OR "endedAt" > "assignedAt"),
  ADD CONSTRAINT "CardAssignment_status_check"
    CHECK ((status = 'ACTIVE') = ("endedAt" IS NULL)),
  ADD CONSTRAINT "CardAssignment_card_no_overlap"
    EXCLUDE USING gist ("cardId" WITH =, tstzrange("assignedAt", "endedAt", '[)') WITH &&),
  ADD CONSTRAINT "CardAssignment_member_no_overlap"
    EXCLUDE USING gist ("memberId" WITH =, tstzrange("assignedAt", "endedAt", '[)') WITH &&);

ALTER TABLE "Card"
  ADD CONSTRAINT "Card_uid_format_check" CHECK ("cardUid" ~ '^[0-9A-F]{8,32}$'),
  ADD CONSTRAINT "Card_revoked_check" CHECK ((status = 'REVOKED') = ("revokedAt" IS NOT NULL));

-- ─────────────── Schedules ───────────────
ALTER TABLE "CdsSchedule"
  ADD CONSTRAINT "CdsSchedule_day_check" CHECK ("dayOfWeek" BETWEEN 1 AND 7),
  ADD CONSTRAINT "CdsSchedule_time_format_check"
    CHECK ("startLocalTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND "endLocalTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  ADD CONSTRAINT "CdsSchedule_time_order_check" CHECK ("endLocalTime" > "startLocalTime"),
  ADD CONSTRAINT "CdsSchedule_effective_check" CHECK ("effectiveUntil" IS NULL OR "effectiveUntil" >= "effectiveFrom"),
  ADD CONSTRAINT "CdsSchedule_no_overlap"
    EXCLUDE USING gist (
      "groupId" WITH =,
      "dayOfWeek" WITH =,
      daterange("effectiveFrom", "effectiveUntil", '[]') WITH &&
    ) WHERE (status = 'ACTIVE');

-- ─────────────── Sessions ───────────────
ALTER TABLE "AttendanceSession"
  ADD CONSTRAINT "AttendanceSession_planned_check" CHECK ("plannedEnd" > "plannedStart"),
  ADD CONSTRAINT "AttendanceSession_actual_check"
    CHECK ("openedAt" IS NULL OR "closedAt" IS NULL OR "closedAt" > "openedAt"),
  ADD CONSTRAINT "AttendanceSession_origin_check"
    CHECK ((origin = 'SCHEDULE') = ("scheduleId" IS NOT NULL)),
  ADD CONSTRAINT "AttendanceSession_cancelled_check"
    CHECK ((status = 'CANCELLED') = ("cancellationReason" IS NOT NULL AND "cancelledAt" IS NOT NULL)),
  ADD CONSTRAINT "AttendanceSession_open_check"
    CHECK (status <> 'OPEN' OR ("openedAt" IS NOT NULL AND "heldConfirmation" IS NOT NULL)),
  ADD CONSTRAINT "AttendanceSession_closed_check"
    CHECK (status <> 'CLOSED' OR ("openedAt" IS NOT NULL AND "closedAt" IS NOT NULL AND "heldConfirmation" IS NOT NULL)),
  -- Two meetings of the same group can never overlap in time (cancelled ones excluded).
  ADD CONSTRAINT "AttendanceSession_no_overlap"
    EXCLUDE USING gist (
      "groupId" WITH =,
      tstzrange("plannedStart", "plannedEnd", '[)') WITH &&
    ) WHERE (status <> 'CANCELLED');

-- ─────────────── Devices ───────────────
ALTER TABLE "Device"
  ADD CONSTRAINT "Device_credential_version_check" CHECK ("credentialVersion" >= 1);

-- ─────────────── Attendance events & records ───────────────
ALTER TABLE "AttendanceEvent"
  ADD CONSTRAINT "AttendanceEvent_reason_check" CHECK ((("ackStatus" = 'REJECTED') = ("ackReason" IS NOT NULL))),
  ADD CONSTRAINT "AttendanceEvent_client_id_check" CHECK (length("clientEventId") BETWEEN 1 AND 64);

ALTER TABLE "AttendanceRecord"
  ADD CONSTRAINT "AttendanceRecord_void_check" CHECK ((status = 'VOIDED') = ("voidedAt" IS NOT NULL AND "voidReason" IS NOT NULL)),
  ADD CONSTRAINT "AttendanceRecord_device_source_check"
    CHECK (source <> 'DEVICE' OR ("deviceId" IS NOT NULL AND "sourceEventId" IS NOT NULL));

-- Attendance data never silently disappears: records and events cannot be deleted, and the
-- acknowledgement given to a device can never be rewritten (so retries get the same answer).
CREATE FUNCTION prevent_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows cannot be deleted', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "AttendanceRecord_no_delete" BEFORE DELETE ON "AttendanceRecord"
  FOR EACH ROW EXECUTE FUNCTION prevent_delete();
CREATE TRIGGER "AttendanceEvent_no_delete" BEFORE DELETE ON "AttendanceEvent"
  FOR EACH ROW EXECUTE FUNCTION prevent_delete();

CREATE FUNCTION attendance_event_ack_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."deviceId" IS DISTINCT FROM OLD."deviceId"
     OR NEW."clientEventId" IS DISTINCT FROM OLD."clientEventId"
     OR NEW."payloadHash" IS DISTINCT FROM OLD."payloadHash"
     OR NEW."cardUid" IS DISTINCT FROM OLD."cardUid"
     OR NEW."capturedAt" IS DISTINCT FROM OLD."capturedAt"
     OR NEW."receivedAt" IS DISTINCT FROM OLD."receivedAt"
     OR NEW."ackStatus" IS DISTINCT FROM OLD."ackStatus"
     OR NEW."ackReason" IS DISTINCT FROM OLD."ackReason" THEN
    RAISE EXCEPTION 'AttendanceEvent acknowledgement fields are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AttendanceEvent_ack_immutable" BEFORE UPDATE ON "AttendanceEvent"
  FOR EACH ROW EXECUTE FUNCTION attendance_event_ack_immutable();

-- Audit log is append-only.
CREATE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog is append-only' USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "AuditLog_append_only" BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
