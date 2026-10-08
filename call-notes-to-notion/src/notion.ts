import type { Actiepunt, CallSummary, IngestMeta } from "./types";

export const NOTION_VERSION = "2025-09-03";
const NOTION_API = "https://api.notion.com/v1";
/** Notion staat max 2000 tekens per rich_text-item toe. */
export const RICH_TEXT_MAX = 2000;
/** Transcriptparagrafen iets korter houden leest prettiger. */
export const PARAGRAPH_MAX = 1800;
/** Max. aantal blokken per append-request. */
export const CHILDREN_BATCH = 100;

export type FetchLike = typeof fetch;

export class NotionError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "NotionError";
  }
}

export interface SelectOptions {
  categorie: string[];
  project: string[];
}

export interface CreatedPage {
  id: string;
  url: string;
}

export class NotionClient {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${NOTION_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    if (!res.ok) {
      const msg =
        typeof json === "object" && json && "message" in json
          ? String((json as { message: unknown }).message)
          : text.slice(0, 300);
      throw new NotionError(`Notion ${method} ${path} -> ${res.status}: ${msg}`, res.status, json);
    }
    return json as T;
  }

  /** Haalt de select-opties van Categorie en Project op, zodat ze nooit uit de pas lopen met Notion. */
  async getSelectOptions(dataSourceId: string): Promise<SelectOptions> {
    const ds = await this.request<{
      properties: Record<string, { type: string; select?: { options: { name: string }[] } }>;
    }>("GET", `/data_sources/${dataSourceId}`);
    const opts = (name: string): string[] =>
      ds.properties?.[name]?.select?.options?.map((o) => o.name) ?? [];
    return { categorie: opts("Categorie"), project: opts("Project") };
  }

  async createPage(args: {
    dataSourceId: string;
    properties: Record<string, unknown>;
    icon?: string;
  }): Promise<CreatedPage> {
    const page = await this.request<{ id: string; url: string }>("POST", "/pages", {
      parent: { type: "data_source_id", data_source_id: args.dataSourceId },
      icon: args.icon ? { type: "emoji", emoji: args.icon } : undefined,
      properties: args.properties,
    });
    return { id: page.id, url: page.url };
  }

  async updateProperties(pageId: string, properties: Record<string, unknown>): Promise<void> {
    await this.request("PATCH", `/pages/${pageId}`, { properties });
  }

  /**
   * Voegt blokken toe in batches van 100. Met `after` worden ze direct na dat blok
   * ingevoegd in plaats van onderaan. Geeft de ids van de aangemaakte blokken terug.
   */
  async appendChildren(blockId: string, blocks: unknown[], after?: string): Promise<string[]> {
    const ids: string[] = [];
    let anchor = after;
    for (let i = 0; i < blocks.length; i += CHILDREN_BATCH) {
      const batch = blocks.slice(i, i + CHILDREN_BATCH);
      const res = await this.request<{ results: { id: string }[] }>(
        "PATCH",
        `/blocks/${blockId}/children`,
        anchor ? { children: batch, after: anchor } : { children: batch },
      );
      const created = res.results.map((r) => r.id);
      ids.push(...created);
      if (anchor) anchor = created[created.length - 1];
    }
    return ids;
  }

  async deleteBlock(blockId: string): Promise<void> {
    await this.request("DELETE", `/blocks/${blockId}`);
  }
}

// ---------- Pure helpers (geen netwerk) ----------

export function richText(text: string): { type: "text"; text: { content: string } }[] {
  if (!text) return [];
  const out: { type: "text"; text: { content: string } }[] = [];
  for (let i = 0; i < text.length; i += RICH_TEXT_MAX) {
    out.push({ type: "text", text: { content: text.slice(i, i + RICH_TEXT_MAX) } });
  }
  return out;
}

/**
 * Splitst lange tekst in stukken van max. `max` tekens, bij voorkeur op
 * alinea- en daarna op zinsgrenzen. Een transcript komt als één blok binnen.
 */
export function splitText(text: string, max = PARAGRAPH_MAX): string[] {
  const cleaned = text.replace(/\r\n/g, "\n").trim();
  if (!cleaned) return [];
  const chunks: string[] = [];
  for (const para of cleaned.split(/\n{2,}/)) {
    const p = para.trim();
    if (!p) continue;
    if (p.length <= max) {
      chunks.push(p);
      continue;
    }
    const sentences = p.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [p];
    let current = "";
    for (const s of sentences) {
      if (s.length > max) {
        if (current) chunks.push(current.trim());
        current = "";
        for (let i = 0; i < s.length; i += max) chunks.push(s.slice(i, i + max).trim());
        continue;
      }
      if ((current + s).length > max) {
        chunks.push(current.trim());
        current = s;
      } else {
        current += s;
      }
    }
    if (current.trim()) chunks.push(current.trim());
  }
  return chunks;
}

type Color = "default" | "blue" | "gray" | "orange" | "red" | "green";

export const block = {
  heading3: (text: string, color: Color = "blue") => ({
    object: "block",
    type: "heading_3",
    heading_3: { rich_text: richText(text), color },
  }),
  paragraph: (text: string) => ({
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: richText(text) },
  }),
  bullet: (text: string) => ({
    object: "block",
    type: "bulleted_list_item",
    bulleted_list_item: { rich_text: richText(text) },
  }),
  todo: (text: string) => ({
    object: "block",
    type: "to_do",
    to_do: { rich_text: richText(text), checked: false },
  }),
  callout: (text: string, emoji: string, color: Color = "gray") => ({
    object: "block",
    type: "callout",
    callout: { rich_text: richText(text), icon: { type: "emoji", emoji }, color: `${color}_background` },
  }),
  toggle: (text: string) => ({
    object: "block",
    type: "toggle",
    toggle: { rich_text: richText(text) },
  }),
  divider: () => ({ object: "block", type: "divider", divider: {} }),
};

function selectOrNull(value: string | undefined, allowed: string[]): { select: { name: string } | null } {
  return value && allowed.includes(value) ? { select: { name: value } } : { select: null };
}

/** Properties voor de placeholderpagina die direct bij ontvangst wordt aangemaakt. */
export function initialProperties(meta: IngestMeta, options: SelectOptions, datumLabel: string) {
  const titel =
    meta.titel?.trim() ||
    (meta.contact ? `Telefoongesprek met ${meta.contact} – ${datumLabel}` : `Telefoongesprek – ${datumLabel}`);
  const props: Record<string, unknown> = {
    Naam: { title: richText(titel) },
    Datum: { date: { start: meta.datum } },
    Contact: { rich_text: richText(meta.contact ?? "") },
    Categorie: selectOrNull(meta.categorie, options.categorie),
  };
  if (meta.project) props.Project = selectOrNull(meta.project, options.project);
  return props;
}

/**
 * Properties na samenvatting. Wat de gebruiker zelf heeft ingevuld wint altijd
 * van wat Claude afleidt.
 */
export function finalProperties(meta: IngestMeta, summary: CallSummary, options: SelectOptions) {
  const props: Record<string, unknown> = {};
  if (!meta.titel?.trim() && summary.titel.trim()) props.Naam = { title: richText(summary.titel.trim()) };
  if (!meta.contact && summary.contact.trim()) props.Contact = { rich_text: richText(summary.contact.trim()) };
  if (!meta.categorie && options.categorie.includes(summary.categorie)) {
    props.Categorie = { select: { name: summary.categorie } };
  }
  if (!meta.project && options.project.includes(summary.project)) {
    props.Project = { select: { name: summary.project } };
  }
  return props;
}

function actiepuntLabel(a: Actiepunt): string {
  const extra = [a.eigenaar.trim(), a.deadline.trim()].filter(Boolean).join(", ");
  return extra ? `${a.actie.trim()} — ${extra}` : a.actie.trim();
}

/** De samenvattingsblokken, in dezelfde stijl als de bestaande Notion-templates (blauwe H3's). */
export function summaryBlocks(summary: CallSummary, meta: IngestMeta, datumLabel: string): unknown[] {
  const blocks: unknown[] = [];
  const contact = (meta.contact || summary.contact || "").trim();
  blocks.push(
    block.callout(
      `Telefoongesprek · ${datumLabel}${contact ? ` · ${contact}` : ""} · automatisch samengevat`,
      "📞",
      "blue",
    ),
  );

  blocks.push(block.heading3("Samenvatting"));
  for (const p of splitText(summary.samenvatting)) blocks.push(block.paragraph(p));

  const list = (title: string, items: string[], kind: "bullet" | "todo" = "bullet") => {
    const clean = items.map((s) => s.trim()).filter(Boolean);
    if (!clean.length) return;
    blocks.push(block.heading3(title));
    for (const item of clean) blocks.push(kind === "todo" ? block.todo(item) : block.bullet(item));
  };

  list("Kernpunten", summary.kernpunten);
  list("Besluiten & afspraken", summary.besluiten_en_afspraken);
  list("Actiepunten", summary.actiepunten.filter((a) => a.actie.trim()).map(actiepuntLabel), "todo");
  list("Openstaande vragen", summary.openstaande_vragen);

  if (summary.vervolg.trim()) {
    blocks.push(block.heading3("Vervolg"));
    for (const p of splitText(summary.vervolg)) blocks.push(block.paragraph(p));
  }

  if (meta.notities?.trim()) {
    blocks.push(block.heading3("Eigen notities"));
    for (const p of splitText(meta.notities)) blocks.push(block.paragraph(p));
  }

  return blocks;
}

/** Divider + lege toggle; het transcript zelf gaat daarna in de toggle (zie transcriptBlocks). */
export function transcriptSectionBlocks(): unknown[] {
  return [block.divider(), block.toggle("Transcript")];
}

export function transcriptBlocks(transcript: string): unknown[] {
  const paras = splitText(transcript);
  if (!paras.length) return [block.paragraph("(leeg transcript)")];
  return paras.map((p) => block.paragraph(p));
}
