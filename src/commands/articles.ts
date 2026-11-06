import { Command, InvalidArgumentError } from "commander";

import { requireArticleKey, withClient } from "../lib/api.js";
import { normalizeTags } from "../lib/articles.js";
import { InputError, NotecliError } from "../lib/errors.js";
import {
  printArticleListText,
  printArticleText,
  printCreatedText,
  printImageText,
  printPreviewText,
  printPublishedText,
  printUpdatedText,
  printWarnings,
} from "../lib/format.js";
import { confirm, resolveBody } from "../lib/input.js";
import {
  createDraft,
  deleteDraft,
  getArticleRaw,
  getPreviewUrl,
  listArticles,
  publishArticle,
  updateArticle,
  uploadImage,
} from "../lib/note-api.js";
import { openUrl } from "../lib/open.js";
import { isJsonOutput, writeJson, writeText } from "../lib/output.js";
import { runAction } from "../lib/runner.js";
import { articleToJson, summaryToJson } from "../lib/serialize.js";

interface TagOptions {
  tags?: string;
  tag?: string[];
}

interface ListOptions {
  status?: string;
  page: number;
  limit: number;
}

interface GetOptions {
  html?: boolean;
  bodyOnly?: boolean;
}

interface CreateOptions extends TagOptions {
  title: string;
  body?: string;
  file?: string;
  stdin?: boolean;
  publish?: boolean;
}

interface UpdateOptions extends TagOptions {
  title?: string;
  body?: string;
  file?: string;
  stdin?: boolean;
}

interface DeleteOptions {
  yes?: boolean;
}

interface PreviewOptions {
  open?: boolean;
}

interface ImageOptions {
  eyecatch?: boolean;
}

function collectTag(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

function addTagOptions(command: Command): Command {
  return command
    .option("--tags <tags>", "comma-separated tags")
    .option("--tag <tag>", "add a tag (repeatable)", collectTag);
}

function tagsFromOptions(options: TagOptions): string[] | undefined {
  const present =
    options.tags !== undefined || (options.tag !== undefined && options.tag.length > 0);
  if (!present) {
    return undefined;
  }

  return normalizeTags([
    ...(options.tag ?? []),
    ...(options.tags !== undefined ? [options.tags] : []),
  ]);
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError("Expected a positive integer.");
  }
  return parsed;
}

function parseStatus(value: string): string | undefined {
  if (value === "all") {
    return undefined;
  }
  if (!["draft", "published", "private"].includes(value)) {
    throw new InvalidArgumentError("Status must be one of: draft, published, private, all.");
  }
  return value;
}

function requireTitle(value: string | undefined): string {
  const title = value?.trim();
  if (!title) {
    throw new InputError("A non-empty --title is required.");
  }
  return title;
}

function attachDraftKey(error: unknown, key: string): unknown {
  if (!(error instanceof NotecliError)) {
    return error;
  }
  return new NotecliError({
    code: error.code,
    message: `Draft "${key}" was created, but publishing it failed: ${error.message}`,
    ...(error.statusCode !== undefined ? { statusCode: error.statusCode } : {}),
    ...(error.retryAfter !== undefined ? { retryAfter: error.retryAfter } : {}),
    details: { ...(error.details ?? {}), draft_key: key },
    cause: error,
  });
}

export function registerArticleCommands(program: Command): void {
  program
    .command("list")
    .alias("ls")
    .description("List your note.com articles")
    .option("--status <status>", "draft, published, private, or all", parseStatus)
    .option("--page <number>", "start page (1-indexed)", parsePositiveInteger, 1)
    .option("--limit <number>", "maximum number of articles to return", parsePositiveInteger, 10)
    .action(
      (options: ListOptions) =>
        runAction(async () => {
          if (options.limit > 1000) {
            throw new InputError("--limit must be 1000 or less.");
          }

          const result = await withClient((client) =>
            listArticles(client, {
              ...(options.status ? { status: options.status } : {}),
              page: options.page,
              limit: options.limit,
            })
          );

          if (isJsonOutput()) {
            writeJson({
              articles: result.articles.map(summaryToJson),
              total: result.total,
              page: result.page,
              has_more: result.hasMore,
            });
          } else {
            printArticleListText(result);
          }
        })
    );

  program
    .command("get <key>")
    .alias("show")
    .description("Get an article by key (Markdown body by default)")
    .option("--html", "print the raw note.com HTML in text mode")
    .option("--body-only", "print only the body in text mode")
    .action(
      (key: string, options: GetOptions) =>
        runAction(async () => {
          const article = await withClient((client) =>
            getArticleRaw(client, requireArticleKey(key))
          );

          if (isJsonOutput()) {
            writeJson(articleToJson(article));
          } else {
            printArticleText(article, {
              html: options.html,
              bodyOnly: options.bodyOnly,
            });
          }
        })
    );

  addTagOptions(
    program
      .command("create")
      .description("Create a draft (and optionally publish it)")
      .requiredOption("--title <title>", "article title")
      .option("--body <markdown>", 'Markdown body, or "-" to read stdin')
      .option("--file <path>", 'read Markdown from a file, or "-" to read stdin')
      .option("--stdin", "read Markdown from stdin")
      .option("--publish", "publish the article immediately")
  ).action(
    (options: CreateOptions) =>
      runAction(async () => {
        const title = requireTitle(options.title);
        const markdown =
          (await resolveBody(
            {
              ...(options.body !== undefined ? { body: options.body } : {}),
              ...(options.file !== undefined ? { file: options.file } : {}),
              ...(options.stdin === true ? { stdin: true } : {}),
            },
            { autoStdin: true }
          )) ?? "";
        const tags = tagsFromOptions(options);

        const result = await withClient(async (client) => {
          const created = await createDraft(client, {
            title,
            markdown,
            ...(tags !== undefined ? { tags } : {}),
          });

          if (options.publish !== true) {
            return {
              article: created.article,
              published: false,
              warnings: created.warnings,
            };
          }

          try {
            const published = await publishArticle(client, created.article.key, tags);
            return {
              article: published.article,
              published: true,
              warnings: [...created.warnings, ...published.warnings],
            };
          } catch (error) {
            throw attachDraftKey(error, created.article.key);
          }
        });

        if (isJsonOutput()) {
          writeJson({
            article: articleToJson(result.article),
            published: result.published,
            warnings: result.warnings,
          });
        } else {
          printCreatedText(result.article, result.published);
          printWarnings(result.warnings);
        }
      })
  );

  addTagOptions(
    program
      .command("update <key>")
      .description("Update an existing article")
      .option("--title <title>", "new title")
      .option("--body <markdown>", 'new Markdown body, or "-" to read stdin')
      .option("--file <path>", 'read Markdown from a file, or "-" to read stdin')
      .option("--stdin", "read the new Markdown body from stdin")
  ).action(
    (key: string, options: UpdateOptions) =>
      runAction(async () => {
        const articleKey = requireArticleKey(key);
        const title = options.title !== undefined ? requireTitle(options.title) : undefined;
        const hasBodyOption =
          options.body !== undefined || options.file !== undefined || options.stdin === true;
        const markdown = hasBodyOption
          ? await resolveBody(
              {
                ...(options.body !== undefined ? { body: options.body } : {}),
                ...(options.file !== undefined ? { file: options.file } : {}),
                ...(options.stdin === true ? { stdin: true } : {}),
              },
              { autoStdin: false }
            )
          : undefined;
        const tags = tagsFromOptions(options);

        if (title === undefined && markdown === undefined && tags === undefined) {
          throw new InputError(
            "Nothing to update. Pass at least one of --title, --body/--file/--stdin, or --tags/--tag."
          );
        }

        const result = await withClient((client) =>
          updateArticle(client, articleKey, {
            ...(title !== undefined ? { title } : {}),
            ...(markdown !== undefined ? { markdown } : {}),
            ...(tags !== undefined ? { tags } : {}),
          })
        );

        if (isJsonOutput()) {
          writeJson({
            article: articleToJson(result.article),
            warnings: result.warnings,
          });
        } else {
          printUpdatedText(result.article);
          printWarnings(result.warnings);
        }
      })
  );

  addTagOptions(
    program
      .command("publish <key>")
      .description("Publish a draft")
  ).action(
    (key: string, options: TagOptions) =>
      runAction(async () => {
        const articleKey = requireArticleKey(key);
        const tags = tagsFromOptions(options);
        const result = await withClient((client) =>
          publishArticle(client, articleKey, tags)
        );

        if (isJsonOutput()) {
          writeJson({
            article: articleToJson(result.article),
            already_published: result.alreadyPublished,
            warnings: result.warnings,
          });
        } else {
          printPublishedText(result.article, result.alreadyPublished);
          printWarnings(result.warnings);
        }
      })
  );

  program
    .command("delete <key>")
    .alias("rm")
    .description("Delete a draft (requires --yes when stdin is not a TTY)")
    .option("--yes", "skip the confirmation prompt")
    .action(
      (key: string, options: DeleteOptions) =>
        runAction(async () => {
          const articleKey = requireArticleKey(key);

          const deleted = await withClient(async (client) => {
            if (options.yes === true) {
              return deleteDraft(client, articleKey);
            }

            if (!process.stdin.isTTY) {
              throw new InputError(
                `Refusing to delete ${articleKey} without confirmation. Pass --yes to delete a draft.`
              );
            }

            const article = await getArticleRaw(client, articleKey);
            const confirmed = await confirm(
              `Delete draft "${article.title}" (${article.key})?`
            );
            if (!confirmed) {
              return null;
            }
            return deleteDraft(client, articleKey);
          });

          if (deleted === null) {
            if (isJsonOutput()) {
              writeJson({ deleted: false, cancelled: true });
            } else {
              writeText("Cancelled.");
            }
            return;
          }

          if (isJsonOutput()) {
            writeJson({
              deleted: true,
              article: {
                id: deleted.id,
                key: deleted.key,
                title: deleted.title,
                status: deleted.status,
              },
            });
          } else {
            writeText(`Deleted draft: "${deleted.title}" (${deleted.key})`);
          }
        })
    );

  program
    .command("preview <key>")
    .description("Create and print a preview URL for a draft")
    .option("--open", "open the preview URL in the default browser")
    .action(
      (key: string, options: PreviewOptions) =>
        runAction(async () => {
          const result = await withClient((client) =>
            getPreviewUrl(client, requireArticleKey(key))
          );

          if (options.open === true) {
            openUrl(result.url);
          }

          if (isJsonOutput()) {
            writeJson(result);
          } else {
            printPreviewText(result.url);
          }
        })
    );

  program
    .command("image <key> <file>")
    .description("Upload an image for an article (body image by default)")
    .option("--eyecatch", "upload as the article's eyecatch image")
    .action(
      (key: string, file: string, options: ImageOptions) =>
        runAction(async () => {
          const kind = options.eyecatch === true ? "eyecatch" : "body";
          const result = await withClient((client) =>
            uploadImage(client, requireArticleKey(key), file, kind)
          );

          if (isJsonOutput()) {
            writeJson(result);
          } else {
            printImageText(result.url, result.markdown, result.kind);
          }
        })
    );
}
