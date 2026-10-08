import type { Project, ReviewField } from '../shared/domain.js';

export const reviewFields: ReviewField[] = ['name', 'description', 'purpose', 'applicableState', 'coreRule', 'verification'];
export function editableFields(project: Project, id: string): ReviewField[] {
  if (!project.addition || !project.baseline?.p0Items.some(c => c.id === id)) return reviewFields;
  return project.addition.fieldPermissions?.[id] ?? [];
}
export function additionUpdateIds(project: Project): string[] {
  return project.draft.candidates.filter(c => editableFields(project, c.id).length).map(c => c.id);
}
