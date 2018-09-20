import { Memoize } from 'typescript-memoize';
import { dirname } from 'path';
import { sync as pkgUpSync }  from 'pkg-up';
import { join } from 'path';
import Funnel from 'broccoli-funnel';
import mergeTrees from 'broccoli-merge-trees';
import { WatchedDir } from 'broccoli-source';
import resolve from 'resolve';
import { todo } from './messages';
import { TrackedImport } from './tracked-imports';
import V1Package from './v1-package';
import { Tree } from 'broccoli-plugin';
import DependencyAnalyzer from './dependency-analyzer';
import ImportParser from './import-parser';
import get from 'lodash/get';
import { V1Config, WriteV1Config } from './v1-config';
import { renamed } from './renaming';

// This controls and types the interface between our new world and the classic
// v1 app instance.
export default class V1App implements V1Package {
  constructor(private app) {
  }

  // always the name from package.json. Not the one that apps may have weirdly
  // customized.
  get name() : string {
    return this.app.project.pkg.name;
  }

  get env(): string {
    return this.app.env;
  }

  @Memoize()
  get root(): string {
    return dirname(pkgUpSync(this.app.root));
  }

  @Memoize()
  private get rootTree() {
    return new WatchedDir(this.root);
  }

  @Memoize()
  get isModuleUnification() {
    let experiments = this.requireFromEmberCLI('./lib/experiments');
    return experiments.MODULE_UNIFICATION && !!this.app.trees.src;
  }

  @Memoize()
  private get emberCLILocation() {
    return dirname(resolve.sync('ember-cli/package.json', { basedir: this.root }));
  }

  private requireFromEmberCLI(specifier) {
    return require(resolve.sync(specifier, { basedir: this.emberCLILocation }));
  }

  private get configReplace() {
    return this.requireFromEmberCLI('broccoli-config-replace');
  }

  private get configLoader() {
    return this.requireFromEmberCLI('broccoli-config-loader');
  }

  private get appUtils() {
    return this.requireFromEmberCLI('./lib/utilities/ember-app-utils');
  }

  private get configTree() {
    return new (this.configLoader)(dirname(this.app.project.configPath()), {
      env: this.app.env,
      tests: this.app.tests || false,
      project: this.app.project,
    });
  }

  @Memoize()
  get config(): V1Config {
    return new V1Config(this.configTree, this.app.env);
  }

  get autoRun(): boolean {
    return this.app.options.autoRun;
  }

  private get storeConfigInMeta(): boolean {
    return this.app.options.storeConfigInMeta;
  }

  get htmlTree() {
    let indexFilePath = this.app.options.outputPaths.app.html;

    let index = new Funnel(this.rootTree, {
      allowEmtpy: true,
      include: [`app/index.html`],
      getDestinationPath: () => indexFilePath,
      annotation: 'app/index.html',
    });

    if (this.isModuleUnification) {
      let srcIndex = new Funnel(this.rootTree, {
        files: ['src/ui/index.html'],
        getDestinationPath: () => indexFilePath,
        annotation: 'src/ui/index.html',
      });

      index = mergeTrees([
        index,
        srcIndex,
      ], {
        overwrite: true,
        annotation: 'merge classic and MU index.html'
      });
    }

    let patterns = this.appUtils.configReplacePatterns({
      addons: this.app.project.addons,
      autoRun: this.autoRun,
      storeConfigInMeta: this.storeConfigInMeta,
      isModuleUnification: this.isModuleUnification
    });

    return new (this.configReplace)(index, this.configTree, {
      configPath: join('environments', `${this.app.env}.json`),
      files: [indexFilePath],
      patterns,
    });
  }

  babelConfig(finalRoot) {
    let plugins = get(this.app.options, 'babel.plugins');
    if (plugins) {
      plugins = plugins.filter(
        // we want to generate a babel config that can be serialized. So
        // already-required functions aren't supported.
        // todo: should we emit a warning?
        p => p && (typeof p === 'string' || typeof p[0] === 'string')
      ).map(p => {
        // resolve (not require) the app's configured plugins relative to the
        // app
        if (typeof p === 'string') {
          return resolve.sync(`babel-plugin-${p}`, { basedir: finalRoot });
        } else {
          return [resolve.sync(`babel-plugin-${p[0]}`, { basedir: finalRoot }), p[1]];
        }
      });
    } else {
      plugins = [];
    }

    // this is our own plugin that patches up issues like non-explicit hbs
    // extensions and packages importing their own names.
    plugins.push([require.resolve('./babel-plugin'), {
      ownName: this.name,
      basedir: finalRoot,
      rename: renamed(this.app.project.addons)
    } ]);

    // this is reproducing what ember-cli-babel does. It would be nicer to just
    // call it, but it require()s all the plugins up front, so not serializable.
    // In its case, it's mostly doing it to set basedir so that broccoli caching
    // will be happy, but that's irrelevant to us here.
    plugins.push(this.debugMacrosPlugin());
    let babelInstance = this.app.project.addons.find(a => a.name === 'ember-cli-babel');
    if (babelInstance._emberVersionRequiresModulesAPIPolyfill()) {
      let ModulesAPIPolyfill = require.resolve('babel-plugin-ember-modules-api-polyfill');
      let blacklist = babelInstance._getEmberModulesAPIBlacklist();
      plugins.push([ModulesAPIPolyfill, { blacklist }]);
    }

    return {
      moduleIds: true,
      babelrc: false,
      plugins,
      presets: [
        ["env", { targets: babelInstance._getTargets() }]
      ]
    };
  }

  private debugMacrosPlugin() {
    let DebugMacros = require.resolve('babel-plugin-debug-macros');
    let isProduction = process.env.EMBER_ENV === 'production';
    let options = {
      envFlags: {
        source: '@glimmer/env',
        flags: { DEBUG: !isProduction, CI: !!process.env.CI }
      },

      externalizeHelpers: {
        global: 'Ember'
      },

      debugTools: {
        source: '@ember/debug',
        assertPredicateIndex: 1
      }
    };
    return [DebugMacros, options];
  }

  get trackedImports(): TrackedImport[] {
    return this.app._trackedImports;
  }

  // our own appTree. Not to be confused with the one that combines the app js
  // from all addons too.
  private get appTree() : Tree {
    todo('more trees: src, tests, styles, templates, bower, vendor, public');
    return new Funnel(this.app.trees.app, {
      exclude: ['styles/**', "*.html"],
    });
  }

  get publicTree(): Tree {
    return this.app.trees.public;
  }

  // this takes the app JS trees from all active addons, since we can't really
  // build our own code without them due to the way addon-provided "app js"
  // works.
  processAppJS(fromAddons: Tree[], packageJSON) : { appJS: Tree, analyzer: DependencyAnalyzer } {
    let appTree = this.appTree;
    let analyzer = new DependencyAnalyzer([new ImportParser(appTree)], packageJSON, true);
    let config = new WriteV1Config(
      this.config,
      this.storeConfigInMeta,
      this.name
    );
    let trees = [...fromAddons, appTree, config];
    return {
      appJS: mergeTrees(trees, { overwrite: true }),
      analyzer
    };
  }

  findAppScript(scripts: HTMLScriptElement[]): HTMLScriptElement {
    return scripts.find(script => script.src === this.app.options.outputPaths.app.js);
  }

  findVendorScript(scripts: HTMLScriptElement[]): HTMLScriptElement {
    return scripts.find(script => script.src === this.app.options.outputPaths.vendor.js);
  }
}