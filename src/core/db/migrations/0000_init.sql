CREATE TABLE `activity` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` integer NOT NULL,
	`message` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `drafts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` integer NOT NULL,
	`version` integer NOT NULL,
	`title` text NOT NULL,
	`problem` text NOT NULL,
	`acceptance_criteria` text NOT NULL,
	`author` text NOT NULL,
	`feedback` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `drafts_item_version_idx` ON `drafts` (`item_id`,`version`);--> statement-breakpoint
CREATE TABLE `duplicate_candidates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` integer NOT NULL,
	`linear_issue_id` text NOT NULL,
	`linear_identifier` text NOT NULL,
	`title` text NOT NULL,
	`url` text NOT NULL,
	`confidence` real NOT NULL,
	`reasoning` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`category` text NOT NULL,
	`triage_state` text,
	`failed_from_state` text,
	`title` text DEFAULT '' NOT NULL,
	`slack_channel` text,
	`slack_thread_ts` text,
	`slack_permalink` text,
	`slack_thread` text,
	`linear_issue_id` text,
	`linear_identifier` text,
	`linear_url` text,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `items_slack_thread_idx` ON `items` (`slack_channel`,`slack_thread_ts`);--> statement-breakpoint
CREATE UNIQUE INDEX `items_linear_issue_idx` ON `items` (`linear_issue_id`);--> statement-breakpoint
CREATE INDEX `items_category_idx` ON `items` (`category`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`item_id` integer NOT NULL,
	`payload` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`run_after` integer NOT NULL,
	`started_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `jobs_status_run_after_idx` ON `jobs` (`status`,`run_after`);--> statement-breakpoint
CREATE TABLE `linear_issue_snapshots` (
	`issue_id` text PRIMARY KEY NOT NULL,
	`status_name` text NOT NULL,
	`label_names` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `poll_cursors` (
	`source` text PRIMARY KEY NOT NULL,
	`cursor` text,
	`last_success_at` integer,
	`last_error` text,
	`last_error_at` integer
);
--> statement-breakpoint
CREATE TABLE `source_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` integer,
	`source` text NOT NULL,
	`kind` text NOT NULL,
	`external_key` text NOT NULL,
	`payload` text NOT NULL,
	`seen_at` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_events_external_key_unique` ON `source_events` (`external_key`);