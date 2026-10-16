import type { Notifier } from '../../services/ports';

export class SilentNotifier implements Notifier {
  notify(): void {}
}
