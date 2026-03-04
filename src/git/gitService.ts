import * as cp from 'child_process';
import * as path from 'path';
import { parseDiff, DiffFile } from './diffParser';

export class GitService {
  constructor(private readonly repoRoot: string) {}

  /** Run a git command in the repo root, resolving with stdout. */
  private git(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      cp.execFile(
        'git',
        args,
        { cwd: this.repoRoot, maxBuffer: 50 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error(stderr.trim() || err.message));
          } else {
            resolve(stdout);
          }
        },
      );
    });
  }

  /** Returns true when there are uncommitted changes in the working tree or index. */
  async hasUncommittedChanges(): Promise<boolean> {
    const out = await this.git(['status', '--porcelain']);
    return out.trim().length > 0;
  }

  /** Returns the name of the currently checked-out branch. */
  async currentBranch(): Promise<string> {
    const out = await this.git(['rev-parse', '--abbrev-ref', 'HEAD']);
    return out.trim();
  }

  /**
   * Get the unified diff of all changes between `baseBranch` and HEAD.
   * Uses three-dot diff so we compare only commits unique to HEAD.
   */
  async getDiffRaw(baseBranch: string): Promise<string> {
    // --diff-filter=d skips deleted submodules; --no-color for clean output
    return this.git([
      'diff',
      '--no-color',
      '--unified=3',
      `${baseBranch}...HEAD`,
    ]);
  }

  /** Parse the diff between baseBranch and HEAD into structured objects. */
  async getDiff(baseBranch: string): Promise<DiffFile[]> {
    const raw = await this.getDiffRaw(baseBranch);
    return parseDiff(raw);
  }

  /**
   * Create a new branch pointing at `baseBranch` and check it out.
   * The caller's working tree must be clean before calling this.
   */
  async createBranchFrom(newBranch: string, baseBranch: string): Promise<void> {
    // Fetch latest base from remote if possible (ignore failures)
    try {
      const remote = await this.getRemoteName();
      if (remote) {
        await this.git(['fetch', remote, baseBranch]).catch(() => undefined);
      }
    } catch {
      // no remote configured — continue
    }

    await this.git(['checkout', '-b', newBranch, baseBranch]);
  }

  /**
   * Apply a patch (unified diff string) to the working tree via `git apply`.
   * Throws if there are conflicts.
   */
  async applyPatch(patchContent: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const proc = cp.spawn('git', ['apply', '--index', '-'], {
        cwd: this.repoRoot,
      });

      let stderr = '';
      proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`git apply failed:\n${stderr.trim()}`));
        } else {
          resolve();
        }
      });
      proc.stdin.write(patchContent);
      proc.stdin.end();
    });
  }

  /** Stage all changes and create a commit. */
  async commit(message: string): Promise<void> {
    await this.git(['commit', '-m', message]);
  }

  /** Push the current branch to the remote. */
  async push(branch: string): Promise<void> {
    const remote = await this.getRemoteName();
    if (!remote) throw new Error('No git remote configured.');
    await this.git(['push', '--set-upstream', remote, branch]);
  }

  /** Return the first configured remote name (usually "origin"). */
  async getRemoteName(): Promise<string> {
    const out = await this.git(['remote']).catch(() => '');
    const remotes = out.trim().split('\n').filter(Boolean);
    return remotes[0] ?? '';
  }

  /**
   * Return the GitHub "Create PR" URL for the given branch, or null if
   * we can't determine the remote URL.
   */
  async getPRUrl(branch: string, baseBranch: string): Promise<string | null> {
    try {
      const remote = await this.getRemoteName();
      if (!remote) return null;

      const url = await this.git(['remote', 'get-url', remote]);
      const repoPath = extractRepoPath(url.trim());
      if (!repoPath) return null;

      const encodedBranch = encodeURIComponent(branch);
      const encodedBase = encodeURIComponent(baseBranch);
      return `https://github.com/${repoPath}/compare/${encodedBase}...${encodedBranch}?expand=1`;
    } catch {
      return null;
    }
  }

  /** Check whether the given branch name already exists locally. */
  async branchExists(name: string): Promise<boolean> {
    try {
      await this.git(['rev-parse', '--verify', `refs/heads/${name}`]);
      return true;
    } catch {
      return false;
    }
  }

  /** Go back to the specified branch (used for cleanup on error). */
  async checkout(branch: string): Promise<void> {
    await this.git(['checkout', branch]);
  }

  /** Delete a local branch (used for cleanup on error). */
  async deleteBranch(branch: string): Promise<void> {
    await this.git(['branch', '-D', branch]);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Extract `owner/repo` from a GitHub remote URL.
 * Handles HTTPS (`https://github.com/owner/repo.git`) and
 * SSH (`git@github.com:owner/repo.git`) formats.
 */
function extractRepoPath(url: string): string | null {
  // HTTPS
  let m = url.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (m) return m[1];
  return null;
}
