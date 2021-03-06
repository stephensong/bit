/** @flow */
import * as pathLib from 'path';
import semver from 'semver';
import fs from 'fs-extra';
import R, { merge, splitWhen } from 'ramda';
import Toposort from 'toposort-class';
import { GlobalRemotes } from '../global-config';
import { flattenDependencyIds, flattenDependencies } from './flatten-dependencies';
import ComponentObjects from './component-objects';
import ComponentModel from './models/component';
import Source from './models/source';
import { Symlink, Version } from './models';
import { Remotes } from '../remotes';
import types from './object-registrar';
import { propogateUntil, currentDirName, pathHas, first, readFile, splitBy, pathNormalizeToLinux } from '../utils';
import {
  BIT_HIDDEN_DIR,
  LATEST,
  OBJECTS_DIR,
  BITS_DIRNAME,
  DEFAULT_DIST_DIRNAME,
  BIT_VERSION,
  DEFAULT_BIT_VERSION
} from '../constants';
import { ScopeJson, getPath as getScopeJsonPath } from './scope-json';
import { ScopeNotFound, ComponentNotFound, ResolutionException, DependencyNotFound } from './exceptions';
import { RemoteScopeNotFound, PermissionDenied } from './network/exceptions';
import { Tmp } from './repositories';
import { BitId, BitIds } from '../bit-id';
import ConsumerComponent from '../consumer/component';
import ComponentVersion from './component-version';
import { Repository, Ref, BitObject } from './objects';
import ComponentWithDependencies from './component-dependencies';
import VersionDependencies from './version-dependencies';
import SourcesRepository from './repositories/sources';
import { postExportHook, postImportHook, postDeprecateHook, postRemoveHook } from '../hooks';
import npmClient from '../npm-client';
import Consumer from '../consumer/consumer';
import { index } from '../search/indexer';
import loader from '../cli/loader';
import { MigrationResult } from '../migration/migration-helper';
import migratonManifest from './migrations/scope-migrator-manifest';
import migrate, { ScopeMigrationResult } from './migrations/scope-migrator';
import {
  BEFORE_PERSISTING_PUT_ON_SCOPE,
  BEFORE_IMPORT_PUT_ON_SCOPE,
  BEFORE_INSTALL_NPM_DEPENDENCIES,
  BEFORE_MIGRATION,
  BEFORE_RUNNING_BUILD,
  BEFORE_RUNNING_SPECS
} from '../cli/loader/loader-messages';
import performCIOps from './ci-ops';
import logger from '../logger/logger';
import componentResolver from '../component-resolver';
import ComponentsList from '../consumer/component/components-list';

const removeNils = R.reject(R.isNil);
const pathHasScope = pathHas([OBJECTS_DIR, BIT_HIDDEN_DIR]);

export type ScopeDescriptor = {
  name: string
};

export type ScopeProps = {
  path: string,
  scopeJson: ScopeJson,
  created?: boolean,
  tmp?: Tmp,
  sources?: SourcesRepository,
  objects?: Repository
};

export default class Scope {
  created: boolean = false;
  scopeJson: ScopeJson;
  tmp: Tmp;
  path: string;
  // sources: SourcesRepository; // for some reason it interferes with the IDE autocomplete
  objects: Repository;

  constructor(scopeProps: ScopeProps) {
    this.path = scopeProps.path;
    this.scopeJson = scopeProps.scopeJson;
    this.created = scopeProps.created || false;
    this.tmp = scopeProps.tmp || new Tmp(this);
    this.sources = scopeProps.sources || new SourcesRepository(this);
    this.objects = scopeProps.objects || new Repository(this, types());
  }

  get groupName(): ?string {
    if (!this.scopeJson.groupName) return null;
    return this.scopeJson.groupName;
  }

  get name(): string {
    return this.scopeJson.name;
  }

  getPath() {
    return this.path;
  }

  getComponentsPath(): string {
    return pathLib.join(this.path, BITS_DIRNAME);
  }

  getBitPathInComponentsDir(id: BitId): string {
    return pathLib.join(this.getComponentsPath(), id.toFullPath());
  }

  /**
   * Running migration process for scope to update the stores (bit objects) to the current version
   *
   * @param {any} verbose - print debug logs
   * @returns {Object} - wether the process run and wether it successeded
   * @memberof Consumer
   */
  async migrate(verbose): MigrationResult {
    logger.debug('running migration process for scope');
    if (verbose) console.log('running migration process for scope'); // eslint-disable-line
    // We start to use this process after version 0.10.9, so we assume the scope is in the last production version
    const scopeVersion = this.scopeJson.get('version') || '0.10.9';
    if (semver.gte(scopeVersion, BIT_VERSION)) {
      logger.debug('scope version is up to date');
      return {
        run: false
      };
    }
    loader.start(BEFORE_MIGRATION);
    const rawObjects = await this.objects.listRawObjects();
    const resultObjects: ScopeMigrationResult = await migrate(scopeVersion, migratonManifest, rawObjects, verbose);
    // Add the new / updated objects
    this.objects.addMany(resultObjects.newObjects);
    // Remove old objects
    await this.objects.removeMany(resultObjects.refsToRemove);
    // Persists new / remove objects
    await this.objects.persist();
    // Update the scope version
    this.scopeJson.set('version', BIT_VERSION);
    logger.debug(`updating scope version to version ${BIT_VERSION}`);
    await this.scopeJson.write(this.getPath());
    return {
      run: true,
      success: true
    };
  }

  remotes(): Promise<Remotes> {
    const self = this;
    function mergeRemotes(globalRemotes: GlobalRemotes) {
      const globalObj = globalRemotes.toPlainObject();
      return Remotes.load(merge(globalObj, self.scopeJson.remotes));
    }

    return GlobalRemotes.load().then(mergeRemotes);
  }

  describe(): ScopeDescriptor {
    return {
      name: this.name
    };
  }

  toConsumerComponents(components: ComponentModel[]): Promise<ConsumerComponent[]> {
    return Promise.all(
      components
        .filter(comp => !(comp instanceof Symlink))
        .map(c => c.toConsumerComponent(c.latestExisting(this.objects).toString(), this.name, this.objects))
    );
  }

  async list(showRemoteVersion?: boolean = false) {
    const components = await this.objects.listComponents();
    const consumerComponents = await this.toConsumerComponents(components);
    if (showRemoteVersion) {
      const componentsIds = consumerComponents.map(component => component.id);
      const latestVersionsInfo = await this.fetchRemoteVersions(componentsIds);
      latestVersionsInfo.forEach((componentId) => {
        const component = consumerComponents.find(
          c => c.id.toStringWithoutVersion() === componentId.toStringWithoutVersion()
        );
        component.latest = componentId.version;
      });
    }
    return ComponentsList.sortComponentsByName(consumerComponents);
  }

  async listStage() {
    const components = await this.objects.listComponents(false);
    const scopeComponents = await this.toConsumerComponents(components.filter(c => !c.scope || c.scope === this.name));
    return ComponentsList.sortComponentsByName(scopeComponents);
  }

  async fetchRemoteVersions(componentIds: BitId[]): Promise<BitId[]> {
    const externals = componentIds.filter(id => !id.isLocal(this.name));
    const remotes = await this.remotes();
    return remotes.latestVersions(externals, this);
  }

  async latestVersions(componentIds: BitId[], throwOnFailure: boolean = true): Promise<BitId[]> {
    componentIds = componentIds.map(componentId => BitId.parse(componentId.toStringWithoutVersion()));
    const components = await this.sources.getMany(componentIds);
    return components.map((component) => {
      const componentId = BitId.parse(component.id.toString());
      if (component.component) {
        componentId.version = component.component.latest();
      } else {
        if (throwOnFailure) throw new ComponentNotFound(component.id.toString());
        componentId.version = DEFAULT_BIT_VERSION;
      }
      return componentId;
    });
  }

  importDependencies(dependencies: BitId[]) {
    return new Promise((resolve, reject) => {
      return this.importMany(dependencies)
        .then(resolve)
        .catch((e) => {
          logger.error(`importDependencies got an error: ${JSON.stringify(e)}`);
          if (e instanceof RemoteScopeNotFound || e instanceof PermissionDenied) return reject(e);
          return reject(new DependencyNotFound(e.id));
        });
    });
  }

  async putMany({
    consumerComponents,
    message,
    exactVersion,
    releaseType,
    force,
    consumer,
    verbose
  }: {
    consumerComponents: ConsumerComponent[],
    message: string,
    exactVersion: ?string,
    releaseType: string,
    force: ?boolean,
    consumer: Consumer,
    verbose: ?boolean
  }): Promise<ComponentWithDependencies> {
    // TODO: Change the return type
    loader.start(BEFORE_IMPORT_PUT_ON_SCOPE);
    const topSort = new Toposort();
    const allDependencies = new Map();
    const consumerComponentsIdsMap = new Map();

    // Concat and unique all the dependencies from all the components so we will not import
    // the same dependency more then once, it's mainly for performance purpose
    consumerComponents.forEach((consumerComponent) => {
      const componentIdString = consumerComponent.id.toString();
      // Store it in a map so we can take it easily from the sorted array which contain only the id
      consumerComponentsIdsMap.set(componentIdString, consumerComponent);
      const dependenciesIdsStrings = consumerComponent.dependencies.map(dependency => dependency.id.toString());
      topSort.add(componentIdString, dependenciesIdsStrings || []);
    });

    // Sort the consumerComponents by the dependency order so we can commit those without the dependencies first
    const sortedConsumerComponentsIds = topSort.sort().reverse();

    const getFlattenForComponent = (consumerComponent, cache) => {
      const flattenedDependenciesP = consumerComponent.dependencies.map(async (dependency) => {
        // Try to get the flatten dependencies from cache
        let flattenedDependencies = cache.get(dependency.id.toString());
        if (flattenedDependencies) return Promise.resolve(flattenedDependencies);

        // Calculate the flatten dependencies
        const versionDependencies = await this.importDependencies([dependency.id]);
        // Copy the exact version from flattenedDependency to dependencies
        if (!dependency.id.hasVersion()) {
          dependency.id.version = first(versionDependencies).component.version;
        }

        flattenedDependencies = await flattenDependencyIds(versionDependencies, this.objects);

        // Store the flatten dependencies in cache
        cache.set(dependency.id.toString(), flattenedDependencies);

        return flattenedDependencies;
      });
      return Promise.all(flattenedDependenciesP);
    };

    // @todo: to make them all run in parallel, we have to first get all compilers from all components, install all
    // environments, then build them all. Otherwise, it'll try to npm-install the same compiler multiple times
    logger.debug('scope.putMany: sequentially build all components');
    loader.start(BEFORE_RUNNING_BUILD);
    for (const consumerComponentId of sortedConsumerComponentsIds) {
      const consumerComponent = consumerComponentsIdsMap.get(consumerComponentId);
      if (consumerComponent) {
        await consumerComponent.build({ scope: this, consumer });
      }
    }

    logger.debug('scope.putMany: sequentially test all components');
    loader.start(BEFORE_RUNNING_SPECS);
    const specsResults = {};
    for (const consumerComponentId of sortedConsumerComponentsIds) {
      const consumerComponent = consumerComponentsIdsMap.get(consumerComponentId);
      if (consumerComponent) {
        specsResults[consumerComponentId] = await consumerComponent.runSpecs({
          scope: this,
          rejectOnFailure: !force,
          consumer,
          verbose
        });
      }
    }

    logger.debug('scope.putMany: sequentially persist all components');
    const persistComponentsP = sortedConsumerComponentsIds.map(consumerComponentId => async () => {
      const consumerComponent = consumerComponentsIdsMap.get(consumerComponentId);
      // This happens when there is a dependency which have been already committed
      if (!consumerComponent) return Promise.resolve([]);
      let flattenedDependencies = await getFlattenForComponent(consumerComponent, allDependencies);
      flattenedDependencies = R.flatten(flattenedDependencies);
      const predicate = id => id.toString(); // TODO: should be moved to BitId class
      flattenedDependencies = R.uniqBy(predicate)(flattenedDependencies);

      const dists =
        consumerComponent.dists && consumerComponent.dists.length
          ? consumerComponent.dists.map((dist) => {
            return {
              name: dist.basename,
              relativePath: pathNormalizeToLinux(dist.relative),
              file: Source.from(dist.contents),
              test: dist.test
            };
          })
          : null;

      const component = await this.sources.addSource({
        source: consumerComponent,
        depIds: flattenedDependencies,
        message,
        exactVersion,
        releaseType,
        dists,
        specsResults: specsResults[consumerComponentId]
      });
      const deps = await component.toVersionDependencies(LATEST, this, this.name);
      consumerComponent.version = deps.component.version;
      await deps.toConsumer(this.objects);
      // await index(consumerComponent, this.getPath());
      return consumerComponent;
    });

    // Run the persistence one by one not in parallel!
    loader.start(BEFORE_PERSISTING_PUT_ON_SCOPE);
    const components = await persistComponentsP.reduce(
      (promise, func) => promise.then(result => func().then(Array.prototype.concat.bind(result))),
      Promise.resolve([])
    );
    await this.objects.persist();

    return components;
  }

  /**
   * Writes a component as an object into the 'objects' directory
   */
  writeComponentToModel(componentObjects: ComponentObjects): Promise<any> {
    const objects = componentObjects.toObjects(this.objects);
    logger.debug(
      `writeComponentToModel, writing into the model, Main id: ${objects.component.id()}. It might have dependencies which are going to be written too`
    );
    return this.sources.merge(objects).then(() => this.objects.persist());
  }

  /**
   * Writes components as objects into the 'objects' directory
   */
  async writeManyComponentsToModel(componentsObjects: ComponentObjects[], persist: boolean = true): Promise<any> {
    const manyObjects = componentsObjects.map(componentObjects => componentObjects.toObjects(this.objects));
    logger.debug(
      `writeComponentToModel, writing into the model, ids: ${manyObjects
        .map(objects => objects.component.id())
        .join(', ')}. They might have dependencies which are going to be written too`
    );
    await Promise.all(manyObjects.map(objects => this.sources.merge(objects)));
    return persist ? this.objects.persist() : Promise.resolve();
  }

  /**
   * When exporting components with dependencies to a bare-scope, some of the dependencies may be created locally and as
   * as result their scope-name is null. Once the bare-scope gets the components, it needs to convert these scope names
   * to the bare-scope name.
   * Since the changes it does affect the Version objects, the version REF of a component, needs to be changed as well.
   */
  _convertNonScopeToCorrectScope(
    componentsObjects: { component: BitObject, objects: BitObject[] },
    remoteScope: string
  ): void {
    const changeScopeIfNeeded = (dependencyId) => {
      if (!dependencyId.scope) {
        const depId = ComponentModel.fromBitId(dependencyId);
        // todo: use 'load' for async and switch the foreach with map.
        const dependencyObject = this.objects.loadSync(depId.hash());
        if (dependencyObject instanceof Symlink) {
          dependencyId.scope = dependencyObject.realScope;
        } else {
          dependencyId.scope = remoteScope;
        }
      }
    };

    componentsObjects.objects.forEach((object: BitObject) => {
      if (object instanceof Version) {
        const hashBefore = object.hash().toString();
        object.dependencies.forEach((dependency) => {
          changeScopeIfNeeded(dependency.id);
        });
        object.flattenedDependencies.forEach((dependency) => {
          changeScopeIfNeeded(dependency);
        });
        const hashAfter = object.hash().toString();
        if (hashBefore !== hashAfter) {
          logger.debug(`switching ${componentsObjects.component.id()} version hash from ${hashBefore} to ${hashAfter}`);
          const versions = componentsObjects.component.versions;
          Object.keys(versions).forEach((version) => {
            if (versions[version].toString() === hashBefore) {
              versions[version] = Ref.from(hashAfter);
            }
          });
        }
      }
    });

    componentsObjects.component.scope = remoteScope;
  }

  /**
   * @TODO there is no real difference between bare scope and a working directory scope - let's adjust terminology to avoid confusions in the future
   * saves a component into the objects directory of the remote scope, then, resolves its
   * dependencies, saves them as well. Finally runs the build process if needed on an isolated
   * environment.
   */
  async exportManyBareScope(componentsObjects: ComponentObjects[]): Promise<ComponentObjects[]> {
    logger.debug(`exportManyBareScope: Going to save ${componentsObjects.length} components`);
    const manyObjects = componentsObjects.map(componentObjects => componentObjects.toObjects(this.objects));
    await Promise.all(manyObjects.map(objects => this.sources.merge(objects, true)));
    const manyCompVersions = await Promise.all(
      manyObjects.map(objects => objects.component.toComponentVersion(LATEST))
    );
    logger.debug('exportManyBareScope: will try to importMany in case there are missing dependencies');
    const versions = await this.importMany(manyCompVersions.map(compVersion => compVersion.id), undefined, true, false); // resolve dependencies
    logger.debug('exportManyBareScope: successfully ran importMany');
    await this.objects.persist();
    await Promise.all(versions.map(version => version.toObjects(this.objects)));
    const manyConsumerComponent = await Promise.all(
      manyCompVersions.map(compVersion => compVersion.toConsumer(this.objects))
    );
    // await Promise.all(manyConsumerComponent.map(consumerComponent => index(consumerComponent, this.getPath())));
    const ids = manyConsumerComponent.map(consumerComponent => consumerComponent.id.toString());
    await postExportHook({ ids });
    await Promise.all(manyConsumerComponent.map(consumerComponent => performCIOps(consumerComponent, this.getPath())));
    return ids;
  }

  getExternalOnes(ids: BitId[], remotes: Remotes, localFetch: boolean = false) {
    logger.debug(`getExternalOnes, ids: ${ids.join(', ')}`);
    return this.sources.getMany(ids).then((defs) => {
      const left = defs.filter((def) => {
        if (!localFetch) return true;
        if (!def.component) return true;
        return false;
      });

      if (left.length === 0) {
        logger.debug('getExternalOnes: no more ids left, all found locally, existing the method');
        return Promise.all(defs.map(def => def.component.toComponentVersion(def.id.version)));
      }

      logger.debug(`getExternalOnes: ${left.length} left. Fetching them from a remote`);
      return remotes
        .fetch(left.map(def => def.id), this, true)
        .then((componentObjects) => {
          return this.writeManyComponentsToModel(componentObjects);
        })
        .then(() => this.getExternalOnes(ids, remotes, true));
    });
  }

  /**
   * If found locally, use them. Otherwise, fetch from remote and then, save into the model.
   */
  getExternalMany(
    ids: BitId[],
    remotes: Remotes,
    localFetch: boolean = true,
    persist: boolean = true
  ): Promise<VersionDependencies[]> {
    logger.debug(
      `getExternalMany, planning on fetching from ${localFetch ? 'local' : 'remote'} scope. Ids: ${ids.join(', ')}`
    );
    return this.sources.getMany(ids).then((defs) => {
      const left = defs.filter((def) => {
        if (!localFetch) return true;
        if (!def.component) return true;
        return false;
      });

      if (left.length === 0) {
        logger.debug('getExternalMany: no more ids left, all found locally, existing the method');
        // $FlowFixMe - there should be a component because there no defs without components left.
        return Promise.all(defs.map(def => def.component.toVersionDependencies(def.id.version, this, def.id.scope)));
      }

      logger.debug(`getExternalMany: ${left.length} left. Fetching them from a remote`);
      return remotes
        .fetch(left.map(def => def.id), this)
        .then((componentObjects) => {
          logger.debug('getExternalMany: writing them to the model');
          return this.writeManyComponentsToModel(componentObjects, persist);
        })
        .then(() => this.getExternalMany(ids, remotes));
    });
  }

  /**
   * If the component is not in the local scope, fetch it from a remote and save into the local
   * scope. (objects directory).
   */
  getExternal({
    id,
    remotes,
    localFetch = true
  }: {
    id: BitId,
    remotes: Remotes,
    localFetch: boolean
  }): Promise<VersionDependencies> {
    return this.sources.get(id).then((component) => {
      if (component && localFetch) {
        return component.toVersionDependencies(id.version, this, id.scope);
      }

      return remotes
        .fetch([id], this)
        .then(([componentObjects]) => {
          return this.writeComponentToModel(componentObjects);
        })
        .then(() => this.getExternal({ id, remotes, localFetch: true }));
    });
  }

  getExternalOne({ id, remotes, localFetch = true }: { id: BitId, remotes: Remotes, localFetch: boolean }) {
    return this.sources.get(id).then((component) => {
      if (component && localFetch) return component.toComponentVersion(id.version);
      return remotes
        .fetch([id], this, true)
        .then(([componentObjects]) => this.writeComponentToModel(componentObjects))
        .then(() => this.getExternal({ id, remotes, localFetch: true }));
    });
  }

  async getObjects(ids: BitId[], withDevDependencies?: boolean): Promise<ComponentObjects[]> {
    const versions = await this.importMany(ids, withDevDependencies);
    return Promise.all(versions.map(version => version.toObjects(this.objects)));
  }

  getObject(hash: string): Promise<BitObject> {
    return new Ref(hash).load(this.objects);
  }

  getRawObject(hash: string): Promise<BitRawObject> {
    return this.objects.loadRawObject(new Ref(hash));
  }

  /**
   * 1. Local objects, fetch from local. (done by this.sources.getMany method)
   * 2. Fetch flattened dependencies (done by toVersionDependencies method). If they're not locally, fetch from remote
   * and save them locally.
   * 3. External objects, fetch from a remote and save locally. (done by this.getExternalOnes method).
   */
  async importMany(
    ids: BitIds,
    withEnvironments?: boolean,
    cache: boolean = true,
    persist: boolean = true
  ): Promise<VersionDependencies[]> {
    logger.debug(`scope.importMany: ${ids.join(', ')}`);
    const idsWithoutNils = removeNils(ids);
    if (R.isEmpty(idsWithoutNils)) return Promise.resolve([]);

    const [externals, locals] = splitWhen(id => id.isLocal(this.name), idsWithoutNils);

    const localDefs = await this.sources.getMany(locals);
    const versionDeps = await Promise.all(
      localDefs.map((def) => {
        if (!def.component) throw new ComponentNotFound(def.id.toString());
        return def.component.toVersionDependencies(def.id.version, this, def.id.scope, withEnvironments);
      })
    );
    logger.debug(
      'scope.importMany: successfully fetched local components and their dependencies. Going to fetch externals'
    );
    await postImportHook({ ids: R.flatten(versionDeps.map(vd => vd.getAllIds())) });
    const remotes = await this.remotes();
    const externalDeps = await this.getExternalMany(externals, remotes, cache, persist);
    return versionDeps.concat(externalDeps);
  }

  async importManyOnes(ids: BitId[], cache: boolean): Promise<ComponentVersion[]> {
    logger.debug(`scope.importManyOnes. Ids: ${ids.join(', ')}`);
    const idsWithoutNils = removeNils(ids);
    if (R.isEmpty(idsWithoutNils)) return Promise.resolve([]);

    const [externals, locals] = splitBy(idsWithoutNils, id => id.isLocal(this.name));

    const localDefs = await this.sources.getMany(locals);
    const componentVersionArr = await Promise.all(
      localDefs.map((def) => {
        if (!def.component) throw new ComponentNotFound(def.id.toString());
        return def.component.toComponentVersion(def.id.version);
      })
    );
    await postImportHook({ ids: componentVersionArr.map(cv => cv.id.toString()) });
    const remotes = await this.remotes();
    const externalDeps = await this.getExternalOnes(externals, remotes, cache);
    return componentVersionArr.concat(externalDeps);
  }

  manyOneObjects(ids: BitId[]): Promise<ComponentObjects[]> {
    return this.importManyOnes(ids).then(componentVersions =>
      Promise.all(
        componentVersions.map((version) => {
          return version.toObjects(this.objects);
        })
      )
    );
  }

  import(id: BitId): Promise<VersionDependencies> {
    if (!id.isLocal(this.name)) {
      return this.remotes().then(remotes => this.getExternal({ id, remotes, localFetch: true }));
    }

    return this.sources.get(id).then((component) => {
      if (!component) throw new ComponentNotFound(id.toString());
      return component.toVersionDependencies(id.version, this, this.name);
    });
  }

  async get(id: BitId): Promise<ConsumerComponent> {
    return this.import(id).then((versionDependencies) => {
      return versionDependencies.toConsumer(this.objects);
    });
  }

  /**
   * get multiple components from a scope, if not found in the local scope, fetch from a remote
   * scope. Then, write them to the local scope.
   */
  getMany(ids: BitId[], cache?: boolean = true): Promise<ComponentWithDependencies[]> {
    logger.debug(`scope.getMany, Ids: ${ids.join(', ')}`);
    const idsWithoutNils = removeNils(ids);
    if (R.isEmpty(idsWithoutNils)) return Promise.resolve([]);
    return this.importMany(idsWithoutNils, false, cache).then((versionDependenciesArr: VersionDependencies[]) => {
      return Promise.all(
        versionDependenciesArr.map(versionDependencies => versionDependencies.toConsumer(this.objects))
      );
    });
  }

  // todo: improve performance by finding all versions needed and fetching them in one request from the server
  // currently it goes to the server twice. First, it asks for the last version of each id, and then it goes again to
  // ask for the older versions.
  async getManyWithAllVersions(ids: BitId[], cache?: boolean = true): Promise<ConsumerComponent[]> {
    logger.debug(`scope.getManyWithAllVersions, Ids: ${ids.join(', ')}`);
    const idsWithoutNils = removeNils(ids);
    if (R.isEmpty(idsWithoutNils)) return Promise.resolve([]);
    const versionDependenciesArr: VersionDependencies[] = await this.importMany(idsWithoutNils, false, cache);

    const allVersionsP = versionDependenciesArr.map((versionDependencies) => {
      const versions = versionDependencies.component.component.listVersions();
      const idsWithAllVersions = versions.map((version) => {
        if (version === versionDependencies.component.version) return null; // imported already
        const versionId = versionDependencies.component.id;
        versionId.version = version;
        return versionId;
      });
      return this.importManyOnes(idsWithAllVersions);
    });
    await Promise.all(allVersionsP);

    return Promise.all(versionDependenciesArr.map(versionDependencies => versionDependencies.toConsumer(this.objects)));
  }

  /**
   * Remove or deprecate single component
   * @removeComponent - boolean - true if you want to remove component
   */
  async removeSingle(bitId: BitId): Promise<string> {
    logger.debug(`removing ${bitId.toString()}`);
    const componentList = await this.objects.listComponents();
    const symlink = componentList.filter(
      link => link instanceof Symlink && link.id() === bitId.toStringWithoutScopeAndVersion()
    );
    await this.sources.clean(bitId, true);
    if (!R.isEmpty(symlink)) await this.objects.remove(symlink[0].hash());
    return bitId.toStringWithoutVersion();
  }

  async deprecateSingle(bitId: BitId): Promise<string> {
    const component = await this.sources.get(bitId);
    component.deprecated = true;
    this.objects.add(component);
    await this.objects.persist();
    return bitId.toStringWithoutVersion();
  }
  /**
   * findDependentBits
   * foreach component in array find the componnet that uses that component
   */
  async findDependentBits(bitIds: Array<BitId>): Promise<Array<object>> {
    const allComponents = await this.objects.listComponents();
    const allConsumerComponents = await this.toConsumerComponents(allComponents);
    const dependentBits = {};
    bitIds.forEach((bitId) => {
      const dependencies = [];
      allConsumerComponents.forEach((stagedComponent) => {
        stagedComponent.flattenedDependencies.forEach((flattendDependencie) => {
          if (flattendDependencie.toStringWithoutVersion() === bitId.toStringWithoutVersion()) {
            dependencies.push(stagedComponent.id.toStringWithoutVersion());
          }
        });
      });
      if (!R.isEmpty(dependencies)) dependentBits[bitId.toStringWithoutVersion()] = dependencies;
    });
    return Promise.resolve(dependentBits);
  }

  /**
   * split bit array to found and missing components (incase user misspelled id)
   */
  async filterFoundAndMissingComponents(bitIds: Array<BitId>) {
    const missingComponents = [];
    const foundComponents = [];
    const resultP = bitIds.map(async (id) => {
      const component = await this.sources.get(id);
      if (!component) missingComponents.push(id.toStringWithoutVersion());
      else foundComponents.push(id);
    });
    await Promise.all(resultP);
    return Promise.resolve({ missingComponents, foundComponents });
  }

  /**
   * Remove components from scope
   * @force Boolean  - remove component from scope even if other components use it
   */
  async removeMany(bitIds: Array<BitId>, force: boolean): Promise<any> {
    logger.debug(`removing ${bitIds} with force flag: ${force}`);
    const { missingComponents, foundComponents } = await this.filterFoundAndMissingComponents(bitIds);
    const removeComponents = () => foundComponents.map(async bitId => this.removeSingle(bitId));

    if (force) {
      const removedComponents = await Promise.all(removeComponents());
      await postRemoveHook({ ids: removedComponents });
      return { bitIds: removedComponents };
    }
    const dependentBits = await this.findDependentBits(foundComponents);
    if (R.isEmpty(dependentBits)) {
      const removedComponents = await Promise.all(removeComponents());
      await postRemoveHook({ ids: removedComponents });
      return { bitIds: removedComponents, missingComponents };
    }
    return { dependentBits, missingComponents };
  }
  /**
   * deprecate components from scope
   */
  async deprecateMany(bitIds: Array<BitId>): Promise<any> {
    const { missingComponents, foundComponents } = await this.filterFoundAndMissingComponents(bitIds);
    const deprecateComponents = () => foundComponents.map(async bitId => this.deprecateSingle(bitId));
    const deprecatedComponents = await Promise.all(deprecateComponents());
    await postDeprecateHook({ ids: deprecatedComponents });
    return { bitIds: deprecatedComponents, missingComponents };
  }

  reset({ bitId, consumer }: { bitId: BitId, consumer?: Consumer }): Promise<consumerComponent> {
    if (!bitId.isLocal(this.name)) {
      return Promise.reject('you can not reset a remote component');
    }
    return this.sources.get(bitId).then((component) => {
      if (!component) throw new ComponentNotFound(bitId.toString());
      const allVersions = component.listVersions();
      if (allVersions.length > 1) {
        const lastVersion = component.latest();
        bitId.version = lastVersion.toString();
        return consumer.removeFromComponents(bitId, true).then(() => {
          // TODO: this won't work any more because the version is now string (semver)
          bitId.version = (lastVersion - 1).toString();
          return this.get(bitId).then((consumerComponent) => {
            const ref = component.versions[lastVersion];
            return this.objects
              .remove(ref)
              .then(() => {
                // todo: remove also all deps of that ref
                delete component.versions[lastVersion];
                this.objects.add(component);
                return this.objects.persist();
              })
              .then(() => consumerComponent);
          });
        });
      }
      return this.get(bitId).then(consumerComponent =>
        consumer.removeFromComponents(bitId).then(() => this.clean(bitId).then(() => consumerComponent))
      );
    });
  }

  loadRemoteComponent(id: BitId): Promise<ConsumerComponent> {
    return this.getOne(id).then((component) => {
      if (!component) throw new ComponentNotFound(id.toString());
      return component.toConsumer(this.objects);
    });
  }

  loadComponent(id: BitId): Promise<ConsumerComponent> {
    logger.debug(`scope.loadComponent, id: ${id}`);
    if (!id.isLocal(this.name)) {
      throw new Error('cannot load bit from remote scope, please import first');
    }

    return this.loadRemoteComponent(id);
  }

  loadComponentLogs(id: BitId): Promise<{ [number]: { message: string, date: string, hash: string } }> {
    return this.sources.get(id).then((componentModel) => {
      if (!componentModel) throw new ComponentNotFound(id.toString());
      return componentModel.collectLogs(this.objects);
    });
  }

  loadAllVersions(id: BitId): Promise<ConsumerComponent> {
    return this.sources.get(id).then((componentModel) => {
      if (!componentModel) throw new ComponentNotFound(id.toString());
      return componentModel.collectVersions(this.objects);
    });
  }

  async getOne(id: BitId): Promise<ComponentVersion> {
    if (!id.isLocal(this.name)) {
      return this.remotes().then(remotes => this.getExternalOne({ id, remotes, localFetch: true }));
    }

    return this.sources.get(id).then((component) => {
      if (!component) throw new ComponentNotFound(id.toString());
      return component.toComponentVersion(id.version);
    });
  }

  /**
   * Creates a symlink object with the local-scope which links to the real-object of the remote-scope
   * This way, local components that have dependencies to the exported component won't break.
   */
  createSymlink(id, remote) {
    const symlink = new Symlink({
      scope: id.scope,
      name: id.name,
      box: id.box,
      realScope: remote
    });
    return this.objects.add(symlink);
  }

  async exportMany(ids: string[], remoteName: string): Promise<ComponentWithDependencies[]> {
    logger.debug(`exportMany, ids: ${ids.join(', ')}`);
    const remotes = await this.remotes();
    const remote = await remotes.resolve(remoteName, this);
    const componentIds = ids.map(id => BitId.parse(id));
    const componentObjectsP = componentIds.map(id => this.sources.getObjects(id));
    const componentObjects = await Promise.all(componentObjectsP);
    const componentsAndObjects = [];
    const manyObjectsP = componentObjects.map(async (componentObject: ComponentObjects) => {
      const componentAndObject = componentObject.toObjects(this.objects);
      this._convertNonScopeToCorrectScope(componentAndObject, remoteName);
      componentsAndObjects.push(componentAndObject);
      const componentBuffer = await componentAndObject.component.compress();
      const objectsBuffer = await Promise.all(componentAndObject.objects.map(obj => obj.compress()));
      return new ComponentObjects(componentBuffer, objectsBuffer);
    });
    const manyObjects = await Promise.all(manyObjectsP);
    let exportedIds;
    try {
      exportedIds = await remote.pushMany(manyObjects);
      logger.debug('exportMany: successfully pushed all ids to the bare-scope, going to save them back to local scope');
    } catch (err) {
      logger.warn('exportMany: failed pushing ids to the bare-scope');
      return Promise.reject(err);
    }
    await Promise.all(componentIds.map(id => this.clean(id)));
    componentIds.map(id => this.createSymlink(id, remoteName));
    const idsWithRemoteScope = exportedIds.map(id => BitId.parse(id));
    await Promise.all(componentsAndObjects.map(componentObject => this.sources.merge(componentObject)));
    await this.objects.persist();
    return idsWithRemoteScope;
  }

  ensureDir() {
    fs.ensureDirSync(this.getComponentsPath());
    return this.tmp
      .ensureDir()
      .then(() => this.scopeJson.write(this.getPath()))
      .then(() => this.objects.ensureDir())
      .then(() => this);
  }

  clean(bitId: BitId): Promise<void> {
    return this.sources.clean(bitId);
  }

  /**
   * sync method that loads the environment/(path to environment component)
   */
  async loadEnvironment(bitId: BitId, opts: ?{ pathOnly?: ?boolean, bareScope?: ?boolean }): Promise<> {
    logger.debug(`scope.loadEnvironment, id: ${bitId}`);
    if (!bitId) throw new ResolutionException();
    const envComponent = (await this.get(bitId)).component;
    const mainFile =
      envComponent.dists && !R.isEmpty(envComponent.dists)
        ? pathLib.join(DEFAULT_DIST_DIRNAME, envComponent.mainFile)
        : envComponent.mainFile;

    if (opts && opts.pathOnly) {
      try {
        const envPath = componentResolver(bitId.toString(), mainFile, this.getPath());
        if (fs.existsSync(envPath)) return envPath;
        throw new Error(`Unable to find an env component ${bitId.toString()}`);
      } catch (e) {
        throw new ResolutionException(e.message);
      }
    }

    try {
      const envFile = componentResolver(bitId.toString(), mainFile, this.getPath());
      logger.debug(`Requiring an environment file at ${envFile}`);
      return require(envFile);
    } catch (e) {
      throw new ResolutionException(e);
    }
  }

  writeToComponentsDir(componentWithDependencies: ComponentWithDependencies[]): Promise<ConsumerComponent[]> {
    const componentsDir = this.getComponentsPath();
    const components: ConsumerComponent[] = flattenDependencies(componentWithDependencies);

    const bitDirForConsumerImport = (component: ConsumerComponent) => {
      return pathLib.join(componentsDir, component.box, component.name, component.scope, component.version);
    };

    return Promise.all(
      components.map((component: ConsumerComponent) => {
        const bitPath = bitDirForConsumerImport(component);
        return component.write({ bitDir: bitPath, withPackageJson: false });
      })
    );
  }

  installEnvironment({ ids, verbose }: { ids: BitId[], verbose?: boolean }): Promise<any> {
    logger.debug(`scope.installEnvironment, ids: ${ids.join(', ')}`);
    const installPackageDependencies = (component: ConsumerComponent) => {
      return npmClient.install(
        component.packageDependencies,
        {
          cwd: this.getBitPathInComponentsDir(component.id)
        },
        verbose
      );
    };

    return this.getMany(ids).then((componentDependenciesArr) => {
      const writeToProperDir = () => {
        return this.writeToComponentsDir(componentDependenciesArr);
      };

      return writeToProperDir().then((components: ConsumerComponent[]) => {
        loader.start(BEFORE_INSTALL_NPM_DEPENDENCIES);
        return Promise.all(components.map(c => installPackageDependencies(c))).then((resultsArr) => {
          if (verbose) {
            loader.stop(); // in order to show npm install output on verbose flag
            resultsArr.forEach(npmClient.printResults);
          }

          return components;
        });
      });
    });
  }

  async bumpDependenciesVersions(componentsToUpdate: BitId[], committedComponents: BitId[], persist: boolean) {
    const componentsObjects = await this.sources.getMany(componentsToUpdate);
    const componentsToUpdateP = componentsObjects.map(async (componentObjects) => {
      const component = componentObjects.component;
      if (!component) return null;
      const latestVersion = await component.loadVersion(component.latest(), this.objects);
      let pendingUpdate = false;
      latestVersion.dependencies.forEach((dependency) => {
        const committedComponentId = committedComponents.find(
          committedComponent => committedComponent.toStringWithoutVersion() === dependency.id.toStringWithoutVersion()
        );

        if (!committedComponentId) return;
        if (persist && semver.gt(committedComponentId.version, dependency.id.version)) {
          pendingUpdate = true;
          dependency.id.version = committedComponentId.version;
          const flattenDependencyToUpdate = latestVersion.flattenedDependencies.find(
            flattenDependency => flattenDependency.toStringWithoutVersion() === dependency.id.toStringWithoutVersion()
          );
          flattenDependencyToUpdate.version = committedComponentId.version;
        } else if (!persist && semver.gte(committedComponentId.version, dependency.id.version)) {
          // if !persist, we only check whether a modified component may cause auto-tagging
          // since it's only modified on the file-system, its version might be the same as the version stored in its
          // dependents. That's why "semver.gte" is used instead of "server.gt".
          pendingUpdate = true;
        }
      });
      if (pendingUpdate) {
        if (!persist) return componentObjects.component;
        const message = 'bump dependencies versions';
        return this.sources.putAdditionalVersion(componentObjects.component, latestVersion, message);
      }
      return null;
    });
    const updatedComponentsAll = await Promise.all(componentsToUpdateP);
    const updatedComponents = removeNils(updatedComponentsAll);
    if (!R.isEmpty(updatedComponents) && persist) {
      await this.objects.persist();
    }
    return updatedComponents;
  }

  async runComponentSpecs({
    bitId,
    consumer,
    environment,
    save,
    verbose,
    isolated,
    directory,
    keep
  }: {
    bitId: BitId,
    consumer?: ?Consumer,
    environment?: ?boolean,
    save?: ?boolean,
    verbose?: ?boolean,
    isolated?: boolean,
    directory?: string,
    keep?: boolean
  }): Promise<?any> {
    if (!bitId.isLocal(this.name)) {
      throw new Error('cannot run specs on remote component');
    }

    const component = await this.loadComponent(bitId);
    return component.runSpecs({
      scope: this,
      consumer,
      environment,
      save,
      verbose,
      isolated,
      directory,
      keep
    });
  }

  async build({
    bitId,
    environment,
    save,
    consumer,
    verbose,
    directory,
    keep,
    ciComponent
  }: {
    bitId: BitId,
    environment?: ?boolean,
    save?: ?boolean,
    consumer?: Consumer,
    verbose?: ?boolean,
    directory: ?string,
    keep: ?boolean,
    ciComponent: any
  }): Promise<string> {
    if (!bitId.isLocal(this.name)) {
      throw new Error('cannot run build on remote component');
    }
    const component = await this.loadComponent(bitId);
    return component.build({ scope: this, environment, save, consumer, verbose, directory, keep, ciComponent });
  }

  async pack({
    bitId,
    directory,
    writeBitDependencies,
    links,
    override
  }: {
    bitId: BitId,
    outputPath: ?string,
    writeBitDependencies: boolean,
    links: boolean,
    override: boolean
  }): Promise<string> {
    if (!bitId.isLocal(this.name)) {
      throw new Error('cannot run build on remote component');
    }
    const component = await this.loadComponent(bitId);
    return component.pack({ scope: this, directory, writeBitDependencies, createNpmLinkFiles: links, override });
  }

  static ensure(path: string = process.cwd(), name: ?string, groupName: ?string) {
    if (pathHasScope(path)) return this.load(path);
    if (!name) name = currentDirName();
    const scopeJson = new ScopeJson({ name, groupName, version: BIT_VERSION });
    return Promise.resolve(new Scope({ path, created: true, scopeJson }));
  }

  static load(absPath: string): Promise<Scope> {
    let scopePath = propogateUntil(absPath, pathHasScope);
    if (!scopePath) throw new ScopeNotFound();
    if (fs.existsSync(pathLib.join(scopePath, BIT_HIDDEN_DIR))) {
      scopePath = pathLib.join(scopePath, BIT_HIDDEN_DIR);
    }
    const path = scopePath;

    return readFile(getScopeJsonPath(scopePath)).then((rawScopeJson) => {
      const scopeJson = ScopeJson.loadFromJson(rawScopeJson.toString());
      return new Scope({ path, scopeJson });
    });
  }
}
