CREATE TABLE `agent_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`item_id` integer NOT NULL,
	`planned_pr_id` integer,
	`kind` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`outcome` text NOT NULL,
	`summary` text,
	`log_path` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`planned_pr_id`) REFERENCES `planned_prs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `planned_prs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` integer NOT NULL,
	`plan_version` integer NOT NULL,
	`position` integer NOT NULL,
	`repo_key` text NOT NULL,
	`github_repo` text NOT NULL,
	`scope` text NOT NULL,
	`branch` text NOT NULL,
	`pr_number` integer,
	`pr_url` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`is_draft` integer DEFAULT false NOT NULL,
	`merged` integer DEFAULT false NOT NULL,
	`unresolved_threads` integer DEFAULT 0 NOT NULL,
	`ci_state` text DEFAULT 'none' NOT NULL,
	`polled_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `planned_prs_item_position_idx` ON `planned_prs` (`item_id`,`position`);--> statement-breakpoint
CREATE TABLE `plans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` integer NOT NULL,
	`version` integer NOT NULL,
	`body` text NOT NULL,
	`breakdown` text NOT NULL,
	`author` text NOT NULL,
	`feedback` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plans_item_version_idx` ON `plans` (`item_id`,`version`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`item_id` integer PRIMARY KEY NOT NULL,
	`container` text NOT NULL,
	`volume` text NOT NULL,
	`image` text NOT NULL,
	`status` text NOT NULL,
	`repos` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `items` ADD `work_state` text;--> statement-breakpoint
ALTER TABLE `items` ADD `work_failed_from_state` text;--> statement-breakpoint
ALTER TABLE `items` ADD `plan_comment_id` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `stop_requested` integer DEFAULT false NOT NULL;