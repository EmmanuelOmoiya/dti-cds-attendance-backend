-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SUPER_ADMIN', 'CDS_ADMIN', 'LGI_VIEWER');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "GroupStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "ScheduleStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "SessionOrigin" AS ENUM ('SCHEDULE', 'AD_HOC');

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('SCHEDULED', 'OPEN', 'CLOSED', 'UNRESOLVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "HeldConfirmation" AS ENUM ('OPENED_LIVE', 'CONFIRMED_RETROSPECTIVELY');

-- CreateEnum
CREATE TYPE "CancellationReason" AS ENUM ('PUBLIC_HOLIDAY', 'OFFICIAL_NYSC_ACTIVITY', 'VENUE_UNAVAILABLE', 'SECURITY', 'WEATHER', 'NOT_HELD', 'SCHEDULE_CHANGED', 'OTHER');

-- CreateEnum
CREATE TYPE "MemberStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "MembershipEndReason" AS ENUM ('TRANSFERRED', 'SERVICE_COMPLETED', 'REMOVED', 'MEMBER_DEACTIVATED', 'DATA_CORRECTION', 'OTHER');

-- CreateEnum
CREATE TYPE "CardStatus" AS ENUM ('UNASSIGNED', 'ASSIGNED', 'REVOKED');

-- CreateEnum
CREATE TYPE "CardRevokeReason" AS ENUM ('LOST', 'DAMAGED', 'STOLEN', 'RETIRED', 'OTHER');

-- CreateEnum
CREATE TYPE "CardAssignmentStatus" AS ENUM ('ACTIVE', 'ENDED');

-- CreateEnum
CREATE TYPE "AssignmentEndReason" AS ENUM ('REPLACED', 'RETURNED', 'LOST', 'DAMAGED', 'STOLEN', 'MEMBER_LEFT', 'REVOKED', 'OTHER');

-- CreateEnum
CREATE TYPE "DeviceStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'REVOKED', 'DECOMMISSIONED');

-- CreateEnum
CREATE TYPE "SyncEventType" AS ENUM ('TOKEN', 'SNAPSHOT', 'UPLOAD', 'HEARTBEAT');

-- CreateEnum
CREATE TYPE "SyncResult" AS ENUM ('SUCCESS', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "EventAckStatus" AS ENUM ('ACCEPTED', 'ALREADY_RECORDED', 'REJECTED');

-- CreateEnum
CREATE TYPE "RejectReason" AS ENUM ('INVALID_TIMESTAMP', 'UNKNOWN_CARD', 'CARD_NOT_ASSIGNED', 'CARD_REVOKED', 'MEMBER_INACTIVE', 'NO_MATCHING_SESSION', 'SESSION_CANCELLED', 'SESSION_NOT_OPEN', 'DEVICE_NOT_AUTHORIZED', 'MEMBER_NOT_IN_GROUP', 'NOT_ELIGIBLE_FOR_SESSION', 'DUPLICATE_EVENT', 'OTHER');

-- CreateEnum
CREATE TYPE "EventResolution" AS ENUM ('NONE', 'RECORD_CREATED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "AttendanceSource" AS ENUM ('DEVICE', 'MANUAL', 'REPROCESSED');

-- CreateEnum
CREATE TYPE "AttendanceRecordStatus" AS ENUM ('PRESENT', 'VOIDED');

-- CreateEnum
CREATE TYPE "VoidReason" AS ENUM ('SESSION_CANCELLED', 'ADMIN_CORRECTION');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'DEVICE', 'SYSTEM', 'ANONYMOUS');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastLoginAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserGroupScope" (
    "userId" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserGroupScope_pkey" PRIMARY KEY ("userId","groupId")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "familyId" UUID NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "replacedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CdsGroup" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "nameNormalized" TEXT NOT NULL,
    "description" TEXT,
    "status" "GroupStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CdsGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CdsSchedule" (
    "id" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "dayOfWeek" SMALLINT NOT NULL,
    "startLocalTime" VARCHAR(5) NOT NULL,
    "endLocalTime" VARCHAR(5) NOT NULL,
    "timezone" TEXT NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveUntil" DATE,
    "status" "ScheduleStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CdsSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceSession" (
    "id" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "scheduleId" UUID,
    "origin" "SessionOrigin" NOT NULL,
    "title" TEXT NOT NULL,
    "occurrenceDate" DATE NOT NULL,
    "timezone" TEXT NOT NULL,
    "plannedStart" TIMESTAMPTZ(3) NOT NULL,
    "plannedEnd" TIMESTAMPTZ(3) NOT NULL,
    "rescheduled" BOOLEAN NOT NULL DEFAULT false,
    "status" "SessionStatus" NOT NULL DEFAULT 'SCHEDULED',
    "openedAt" TIMESTAMPTZ(3),
    "closedAt" TIMESTAMPTZ(3),
    "heldConfirmation" "HeldConfirmation",
    "heldConfirmedAt" TIMESTAMPTZ(3),
    "heldConfirmedById" UUID,
    "cancellationReason" "CancellationReason",
    "cancellationNote" TEXT,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelledById" UUID,
    "unresolvedAt" TIMESTAMPTZ(3),
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AttendanceSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Member" (
    "id" UUID NOT NULL,
    "fullName" TEXT NOT NULL,
    "stateCode" TEXT NOT NULL,
    "status" "MemberStatus" NOT NULL DEFAULT 'ACTIVE',
    "deactivatedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupMembership" (
    "id" UUID NOT NULL,
    "memberId" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "joinedAt" TIMESTAMPTZ(3) NOT NULL,
    "leftAt" TIMESTAMPTZ(3),
    "endReason" "MembershipEndReason",
    "endNote" TEXT,
    "transferredToMembershipId" UUID,
    "createdById" UUID,
    "endedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "GroupMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Card" (
    "id" UUID NOT NULL,
    "cardUid" TEXT NOT NULL,
    "label" TEXT,
    "status" "CardStatus" NOT NULL DEFAULT 'UNASSIGNED',
    "revokedAt" TIMESTAMPTZ(3),
    "revokeReason" "CardRevokeReason",
    "revokeNote" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Card_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CardAssignment" (
    "id" UUID NOT NULL,
    "cardId" UUID NOT NULL,
    "memberId" UUID NOT NULL,
    "assignedAt" TIMESTAMPTZ(3) NOT NULL,
    "endedAt" TIMESTAMPTZ(3),
    "status" "CardAssignmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "endReason" "AssignmentEndReason",
    "endNote" TEXT,
    "replacedByAssignmentId" UUID,
    "assignedById" UUID,
    "endedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CardAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" UUID NOT NULL,
    "deviceIdentifier" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "assignedGroupId" UUID NOT NULL,
    "status" "DeviceStatus" NOT NULL DEFAULT 'PENDING',
    "statusReason" TEXT,
    "secretHash" TEXT NOT NULL,
    "credentialVersion" INTEGER NOT NULL DEFAULT 1,
    "credentialRotatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMPTZ(3),
    "suspendedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "decommissionedAt" TIMESTAMPTZ(3),
    "lastSeenAt" TIMESTAMPTZ(3),
    "lastSyncAt" TIMESTAMPTZ(3),
    "lastStatus" JSONB,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncEvent" (
    "id" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "type" "SyncEventType" NOT NULL,
    "result" "SyncResult" NOT NULL,
    "batchId" TEXT,
    "itemsReceived" INTEGER NOT NULL DEFAULT 0,
    "itemsAccepted" INTEGER NOT NULL DEFAULT 0,
    "itemsAlreadyRecorded" INTEGER NOT NULL DEFAULT 0,
    "itemsRejected" INTEGER NOT NULL DEFAULT 0,
    "itemsRetry" INTEGER NOT NULL DEFAULT 0,
    "deviceTime" TIMESTAMPTZ(3),
    "clockSkewMs" INTEGER,
    "durationMs" INTEGER,
    "errorCode" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceEvent" (
    "id" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "clientEventId" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "cardUid" TEXT NOT NULL,
    "claimedSessionId" UUID,
    "sessionId" UUID,
    "cardId" UUID,
    "cardAssignmentId" UUID,
    "memberId" UUID,
    "capturedAt" TIMESTAMPTZ(3) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clockSkewMs" INTEGER,
    "sessionReassigned" BOOLEAN NOT NULL DEFAULT false,
    "ackStatus" "EventAckStatus" NOT NULL,
    "ackReason" "RejectReason",
    "attendanceRecordId" UUID,
    "resolution" "EventResolution" NOT NULL DEFAULT 'NONE',
    "resolutionNote" TEXT,
    "resolvedAt" TIMESTAMPTZ(3),
    "resolvedById" UUID,
    "syncEventId" UUID,

    CONSTRAINT "AttendanceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceRecord" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "memberId" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "cardAssignmentId" UUID,
    "deviceId" UUID,
    "sourceEventId" UUID,
    "source" "AttendanceSource" NOT NULL,
    "capturedAt" TIMESTAMPTZ(3) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lateSync" BOOLEAN NOT NULL DEFAULT false,
    "status" "AttendanceRecordStatus" NOT NULL DEFAULT 'PRESENT',
    "note" TEXT,
    "voidReason" "VoidReason",
    "voidNote" TEXT,
    "voidedAt" TIMESTAMPTZ(3),
    "voidedById" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AttendanceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" BIGSERIAL NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "actorId" UUID,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "groupId" UUID,
    "metadata" JSONB,
    "requestId" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "UserGroupScope_groupId_idx" ON "UserGroupScope"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex
CREATE INDEX "RefreshToken_familyId_idx" ON "RefreshToken"("familyId");

-- CreateIndex
CREATE UNIQUE INDEX "CdsGroup_nameNormalized_key" ON "CdsGroup"("nameNormalized");

-- CreateIndex
CREATE INDEX "CdsSchedule_groupId_status_idx" ON "CdsSchedule"("groupId", "status");

-- CreateIndex
CREATE INDEX "AttendanceSession_groupId_plannedStart_idx" ON "AttendanceSession"("groupId", "plannedStart");

-- CreateIndex
CREATE INDEX "AttendanceSession_groupId_occurrenceDate_idx" ON "AttendanceSession"("groupId", "occurrenceDate");

-- CreateIndex
CREATE INDEX "AttendanceSession_status_plannedEnd_idx" ON "AttendanceSession"("status", "plannedEnd");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceSession_scheduleId_occurrenceDate_key" ON "AttendanceSession"("scheduleId", "occurrenceDate");

-- CreateIndex
CREATE UNIQUE INDEX "Member_stateCode_key" ON "Member"("stateCode");

-- CreateIndex
CREATE UNIQUE INDEX "GroupMembership_transferredToMembershipId_key" ON "GroupMembership"("transferredToMembershipId");

-- CreateIndex
CREATE INDEX "GroupMembership_memberId_joinedAt_idx" ON "GroupMembership"("memberId", "joinedAt");

-- CreateIndex
CREATE INDEX "GroupMembership_groupId_joinedAt_idx" ON "GroupMembership"("groupId", "joinedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Card_cardUid_key" ON "Card"("cardUid");

-- CreateIndex
CREATE UNIQUE INDEX "CardAssignment_replacedByAssignmentId_key" ON "CardAssignment"("replacedByAssignmentId");

-- CreateIndex
CREATE INDEX "CardAssignment_cardId_assignedAt_idx" ON "CardAssignment"("cardId", "assignedAt");

-- CreateIndex
CREATE INDEX "CardAssignment_memberId_assignedAt_idx" ON "CardAssignment"("memberId", "assignedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Device_deviceIdentifier_key" ON "Device"("deviceIdentifier");

-- CreateIndex
CREATE INDEX "Device_assignedGroupId_idx" ON "Device"("assignedGroupId");

-- CreateIndex
CREATE INDEX "SyncEvent_deviceId_createdAt_idx" ON "SyncEvent"("deviceId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AttendanceEvent_deviceId_receivedAt_idx" ON "AttendanceEvent"("deviceId", "receivedAt" DESC);

-- CreateIndex
CREATE INDEX "AttendanceEvent_ackStatus_resolution_sessionId_idx" ON "AttendanceEvent"("ackStatus", "resolution", "sessionId");

-- CreateIndex
CREATE INDEX "AttendanceEvent_sessionId_idx" ON "AttendanceEvent"("sessionId");

-- CreateIndex
CREATE INDEX "AttendanceEvent_memberId_idx" ON "AttendanceEvent"("memberId");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceEvent_deviceId_clientEventId_key" ON "AttendanceEvent"("deviceId", "clientEventId");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceRecord_sourceEventId_key" ON "AttendanceRecord"("sourceEventId");

-- CreateIndex
CREATE INDEX "AttendanceRecord_sessionId_status_idx" ON "AttendanceRecord"("sessionId", "status");

-- CreateIndex
CREATE INDEX "AttendanceRecord_memberId_capturedAt_idx" ON "AttendanceRecord"("memberId", "capturedAt" DESC);

-- CreateIndex
CREATE INDEX "AttendanceRecord_deviceId_idx" ON "AttendanceRecord"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceRecord_sessionId_memberId_key" ON "AttendanceRecord"("sessionId", "memberId");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_createdAt_idx" ON "AuditLog"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_groupId_createdAt_idx" ON "AuditLog"("groupId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- AddForeignKey
ALTER TABLE "UserGroupScope" ADD CONSTRAINT "UserGroupScope_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserGroupScope" ADD CONSTRAINT "UserGroupScope_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "CdsGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CdsSchedule" ADD CONSTRAINT "CdsSchedule_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "CdsGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceSession" ADD CONSTRAINT "AttendanceSession_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "CdsGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceSession" ADD CONSTRAINT "AttendanceSession_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "CdsSchedule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupMembership" ADD CONSTRAINT "GroupMembership_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupMembership" ADD CONSTRAINT "GroupMembership_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "CdsGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupMembership" ADD CONSTRAINT "GroupMembership_transferredToMembershipId_fkey" FOREIGN KEY ("transferredToMembershipId") REFERENCES "GroupMembership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardAssignment" ADD CONSTRAINT "CardAssignment_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "Card"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardAssignment" ADD CONSTRAINT "CardAssignment_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardAssignment" ADD CONSTRAINT "CardAssignment_replacedByAssignmentId_fkey" FOREIGN KEY ("replacedByAssignmentId") REFERENCES "CardAssignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_assignedGroupId_fkey" FOREIGN KEY ("assignedGroupId") REFERENCES "CdsGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncEvent" ADD CONSTRAINT "SyncEvent_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceEvent" ADD CONSTRAINT "AttendanceEvent_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceEvent" ADD CONSTRAINT "AttendanceEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AttendanceSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceEvent" ADD CONSTRAINT "AttendanceEvent_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "Card"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceEvent" ADD CONSTRAINT "AttendanceEvent_cardAssignmentId_fkey" FOREIGN KEY ("cardAssignmentId") REFERENCES "CardAssignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceEvent" ADD CONSTRAINT "AttendanceEvent_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceEvent" ADD CONSTRAINT "AttendanceEvent_attendanceRecordId_fkey" FOREIGN KEY ("attendanceRecordId") REFERENCES "AttendanceRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceEvent" ADD CONSTRAINT "AttendanceEvent_syncEventId_fkey" FOREIGN KEY ("syncEventId") REFERENCES "SyncEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AttendanceSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "GroupMembership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_cardAssignmentId_fkey" FOREIGN KEY ("cardAssignmentId") REFERENCES "CardAssignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_sourceEventId_fkey" FOREIGN KEY ("sourceEventId") REFERENCES "AttendanceEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
