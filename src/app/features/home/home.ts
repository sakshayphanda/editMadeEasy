import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { audioTools } from '../audio/audio-tools';
import { suiteTools, toolGroups } from '../suite/tools';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-home',
  imports: [RouterLink, FormsModule],
  templateUrl: './home.html',
  styleUrl: './home.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Home {
  protected readonly query = signal('');
  protected readonly groups = computed(() =>
    toolGroups.map((group) => ({
      ...group,
      tools: [
        ...(group.id === 'audio' ? audioTools.map((tool) => ({ ...tool, group: 'audio' })) : []),
        ...suiteTools.filter((tool) => tool.group === group.id),
      ].filter((tool) =>
        `${tool.title} ${tool.description}`
          .toLowerCase()
          .includes(this.query().toLowerCase().trim()),
      ),
    })),
  );
  protected readonly count = suiteTools.length + audioTools.length;
}
