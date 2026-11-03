import catalog from './tools.json';

export interface ToolField {
  key: string;
  label: string;
  default: string | number;
  min: number;
  max: number;
  step: number;
  type: string;
  choices: (string | number)[];
}
export interface SuiteTool {
  group: string;
  id: string;
  title: string;
  description: string;
  accept: string;
  multiple: boolean;
  fields: ToolField[];
  formats: string[];
  mode: string;
  engine: string;
}
export const suiteTools: SuiteTool[] = catalog;
export const toolGroups = [
  { id: 'video', title: 'Video tools', icon: '▶' },
  { id: 'audio', title: 'Audio tools', icon: '♫' },
  { id: 'pdf', title: 'PDF tools', icon: '▤' },
  { id: 'convert', title: 'Converters', icon: '⇄' },
];
