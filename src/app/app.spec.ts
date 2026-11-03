import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { App } from './app';
import { routes } from './app.routes';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter(routes)],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('should render the home page', async () => {
    const harness = await RouterTestingHarness.create('/');
    expect(harness.routeNativeElement?.querySelector('h1')?.textContent).toBe('Edit Made Easy');
  });

  it.each(['compressor', 'volume', 'trimmer', 'denoise'])(
    'should open the audio %s tool',
    async (tool) => {
      const harness = await RouterTestingHarness.create(`/audio/${tool}`);
      expect(harness.routeNativeElement?.querySelector('input[type="file"]')).toBeTruthy();
      expect(harness.routeNativeElement?.querySelector('h1')?.textContent).toContain('Audio');
    },
  );
});
