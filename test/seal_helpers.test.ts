import { clearSessionCache } from '../src/seal_helpers';

describe('clearSessionCache', () => {
  it('is exported and callable', () => {
    expect(typeof clearSessionCache).toBe('function');
  });

  it('does not throw when the cache is empty', () => {
    expect(() => clearSessionCache()).not.toThrow();
  });

  it('can be called multiple times without error', () => {
    clearSessionCache();
    clearSessionCache();
    clearSessionCache();
  });
});
