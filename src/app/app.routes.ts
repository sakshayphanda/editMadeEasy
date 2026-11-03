import { Routes } from '@angular/router';
import { audioTools } from './features/audio/audio-tools';
import { suiteTools } from './features/suite/tools';

export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    title: 'Edit Made Easy',
    loadComponent: () => import('./features/home/home').then((m) => m.Home),
  },
  ...audioTools.map((tool) => ({
    path: `audio/${tool.id}`,
    title: `${tool.title} | Edit Made Easy`,
    data: { tool },
    loadComponent: () =>
      tool.id === 'youtube'
        ? import('./features/youtube/youtube').then((m) => m.Youtube)
        : import('./features/audio/audio').then((m) => m.Audio),
  })),
  ...suiteTools.map((tool) => ({
    path: `${tool.group}/${tool.id}`,
    title: `${tool.title} | Edit Made Easy`,
    data: { tool },
    loadComponent: () => import('./features/suite/suite').then((m) => m.Suite),
  })),
  { path: '**', redirectTo: '' },
];
