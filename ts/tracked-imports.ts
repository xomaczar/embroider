import { todo } from './messages';
import { Memoize } from 'typescript-memoize';

export interface TrackedImport {
  assetPath: string;
  options: { type: string, outputFile: string | undefined };
}

export class TrackedImports {
  constructor(private packageName: string, private trackedImports: TrackedImport[]) {
  }

  @Memoize()
  get categorized(): { app: string[], test: string[] } {
    let app = [];
    let test = [];

    if (this.trackedImports) {
      this.trackedImports.forEach(({ assetPath, options }) => {
        if (!/\.js$/i.test(assetPath)) {
          todo(`Skipping non-js app.import ${assetPath}`);
          return;
        }
        let standardAssetPath = standardizeAssetPath(this.packageName, assetPath);
        if (!standardAssetPath) {
          return;
        }
        if (options.type === 'vendor') {
          if (options.outputFile && options.outputFile !== '/assets/vendor.js') {
            todo(`${this.packageName} is app.importing vendor assets into a nonstandard output file ${options.outputFile}`);
          }
          app.push(standardAssetPath);
        } else if (options.type === 'test') {
          test.push(standardAssetPath);
        } else {
          todo(`${this.packageName} has a non-standard app.import type ${options.type} for asset ${assetPath}`);
        }
      });
    }
    return { app, test };
  }

  get meta() {
    let result = {};
    if (this.categorized.app.length > 0) {
      result['implicit-scripts'] = this.categorized.app.slice();
    }
    if (this.categorized.test.length > 0) {
      result['implicit-test-scripts4'] = this.categorized.test.slice();
    }
    return result;
  }
}

function standardizeAssetPath(packageName, assetPath) {
  let [first, ...rest] = assetPath.split('/');
  if (first === 'vendor') {
    // our vendor tree is available via relative import
    return './vendor/' + rest.join('/');
  } else if (first === 'node_modules') {
    // our node_modules are allowed to be resolved directly
    return rest.join('/');
  } else {
    todo(`${packageName} app.imported from unknown path ${assetPath}`);
  }
}