import type { BlockModels, PrintingPlan, Project } from "./types";

/** The server answers errors as {error: string}; anything else is a surprise. */
async function failure(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string") {
      return body.error;
    }
  } catch {
    // Fall through to the generic message below.
  }
  return `The server answered ${response.status}.`;
}

/** Reads a project that was uploaded earlier. */
export async function fetchProject(id: string): Promise<Project> {
  const response = await fetch(`/api/projects/${encodeURIComponent(id)}`);
  if (!response.ok) {
    throw new Error(await failure(response));
  }
  return (await response.json()) as Project;
}

/** The packed block indices, exactly as the server stored them. */
export async function fetchIndices(id: string): Promise<ArrayBuffer> {
  const response = await fetch(`/api/projects/${id}/indices`);
  if (!response.ok) {
    throw new Error(await failure(response));
  }
  return response.arrayBuffer();
}

/**
 * The real model of every block state, or null when the export carries none.
 *
 * <p>A missing model file is a normal answer rather than a failure: exports
 * made before models existed, or with them switched off, simply have none, and
 * the viewer falls back to drawing boxes.
 */
export async function fetchModels(id: string): Promise<BlockModels | null> {
  const response = await fetch(`/api/projects/${encodeURIComponent(id)}/models`);
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(await failure(response));
  }
  return (await response.json()) as BlockModels;
}

/** Saves which block prints in which filament. */
export async function savePrinting(id: string, plan: PrintingPlan): Promise<void> {
  const response = await fetch(`/api/projects/${encodeURIComponent(id)}/printing`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slots: plan.slots, assignment: plan.assignment }),
  });
  if (!response.ok) {
    throw new Error(await failure(response));
  }
}

export async function uploadProject(file: File): Promise<Project> {
  const body = new FormData();
  body.append("file", file);

  const response = await fetch("/api/projects", { method: "POST", body });
  if (!response.ok) {
    throw new Error(await failure(response));
  }
  return (await response.json()) as Project;
}
