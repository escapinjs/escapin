import { cosmiconfigSync } from 'cosmiconfig';
import deasync from 'deasync';
import fs from 'fs';
import ignore, { Ignore } from 'ignore';
import { safeLoad as loadYaml, dump as dumpYaml } from 'js-yaml';
import { mergeWith } from 'lodash';
import _mkdirp from 'mkdirp';
import { OpenAPIV2 } from 'openapi-types';
import Path from 'path';
import { sync as rimraf } from 'rimraf';
import { dereference } from 'swagger-parser';
import { v4 as uuid } from 'uuid';
import vm from 'vm';
import * as u from './util';
import { BaseState } from './state';
import { finalize, steps } from './steps';
import { TypeDictionary } from './types';

const mkdirp = deasync(_mkdirp);

export interface IConfig {
  name: string;
  platform: string;
  default_storage: string;
  output_dir: string;
  api_spec?: string;
  credentials?: ICredential[];
}

export interface ICredential {
  api: string;
  [x: string]: string;
}

export interface IPackageJson {
  main?: string;
  scripts?: { [script: string]: string };
  dependencies: { [moduleName: string]: string };
  devDependencies: { [moduleName: string]: string };
  peerDependencies?: { [moduleName: string]: string };
  optionalDependencies?: { [moduleName: string]: string };
  bundledDependencies?: string[];
  types?: string;
  typings?: string;
  [key: string]: any;
}

export interface IServerlessConfig {
  service?: string;
  provider?: any;
  functions?: { [name: string]: any };
  resources?: { [name: string]: any };
}

const API_SPEC_FILENAME = process.env.API_SPEC_FILENAME || 'apispec_bundled.json';
const PLATFORM = 'aws';
const OUTPUT_DIR = 'build';
const DEFAULT_STORAGE = 'table';
const SERVERLESS_YML = 'serverless.yml';
export const EXTENSIONS = ['.js', '.mjs', '.jsx'];

export class Escapin {
  public id: string;
  public basePath: string;
  public ignorePath: string;
  public states: { [file: string]: BaseState };
  public apiSpec!: {
    file: string;
    data: OpenAPIV2.Document;
  };
  public config!: IConfig;
  public packageJson!: IPackageJson;
  public types: TypeDictionary;
  public serverlessConfig!: IServerlessConfig;

  constructor(basePath: string, ignorePath: string = '.gitignore') {
    this.id = uuid();
    this.basePath = Path.resolve(basePath);
    this.ignorePath = ignorePath;
    this.states = {};
    this.types = new TypeDictionary();
  }

  public transpile() {
    this.load();

    for (const step of steps) {
      step(this);
      this.updateJSFiles();
    }

    this.save();
  }

  public load() {
    this.loadConfig();
    this.loadPackageJson();
    this.loadAPISpec();
    this.loadServerlessConfig();
    this.loadJSFiles();
  }

  public save() {
    this.savePackageJson();
    this.saveAPISpec();
    this.saveServerlessConfig();
    this.saveJSFiles();
  }

  private loadConfig() {
    const result = cosmiconfigSync('escapin').search(this.basePath);
    if (result === null) {
      throw new Error('config file not found.');
    }
    result.config.output_dir = Path.join(this.basePath, result.config.output_dir || OUTPUT_DIR);
    if (fs.existsSync(result.config.output_dir)) {
      rimraf(result.config.output_dir);
    }
    mkdirp(result.config.output_dir);

    result.config.platform = result.config.platform || PLATFORM;
    result.config.default_storage = result.config.default_storage || DEFAULT_STORAGE;

    this.config = result.config as IConfig;
  }

  private loadPackageJson() {
    const packageJsonPath = Path.join(this.basePath, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
      throw new Error('The project does not contain package.json.');
    }
    this.packageJson = JSON.parse(fs.readFileSync(packageJsonPath).toString());
    this.packageJson.dependencies = this.packageJson.dependencies || {};
    this.packageJson.devDependencies = this.packageJson.devDependencies || {};
    switch (this.config.platform) {
      case 'aws':
        this.addDependency('aws-sdk', 'devDependencies');
        break;
      default:
        break;
    }
  }

  public addDependency(
    moduleName: string,
    location: 'dependencies' | 'devDependencies' = 'dependencies',
  ) {
    this.packageJson[location][moduleName] = `^${u.getLatestVersion(moduleName)}`;
  }

  private savePackageJson() {
    const filePath = Path.join(this.config.output_dir, 'package.json');
    fs.writeFileSync(filePath, JSON.stringify(this.packageJson, null, 2));
  }

  private loadAPISpec() {
    if (this.config.api_spec) {
      const filename = Path.join(this.basePath, this.config.api_spec);
      console.log(`load api spec ${filename}`);
      const data = u.deasyncPromise(dereference(filename));
      if (data === null || data === undefined) {
        throw new Error(`dereferencing ${filename} results 'undefined'.`);
      }
      if (!u.isOpenAPIV2Document(data)) {
        throw new Error('Escapin does not support OpenAPI v3 api spec.');
      }
      const commonParamsOnPaths = data.paths.parameters || [];
      for (const path in data.paths) {
        const commonParams = commonParamsOnPaths;
        if (path === 'parameters') {
          continue;
        }
        if ('parameters' in data.paths[path]) {
          commonParams.push(...data.paths[path].parameters);
        }
        for (const method in data.paths[path]) {
          if (method === 'parameters') {
            continue;
          }
          data.paths[path][method].parameters = data.paths[path][method].parameters
            ? [...data.paths[path][method].parameters, ...commonParams]
            : commonParams;
          data.paths[path][method].responses.default = undefined;
        }
      }
      for (const key in data.definitions) {
        data.definitions[key].example = undefined;
      }
      fs.writeFileSync(
        Path.join(this.config.output_dir, API_SPEC_FILENAME),
        JSON.stringify(data, null, 2),
        'utf8',
      );
      this.config.api_spec = API_SPEC_FILENAME;
      this.apiSpec = { file: API_SPEC_FILENAME, data };
    }
  }

  private saveAPISpec() {
    if (this.apiSpec !== undefined) {
      fs.writeFileSync(
        Path.join(this.config.output_dir, this.apiSpec.file),
        JSON.stringify(this.apiSpec.data, null, 2),
        'utf8',
      );
    }
  }

  private loadJSFilesRecursive(current: string, ig: Ignore) {
    const names = fs.readdirSync(current, 'utf8');
    for (const name of names) {
      const path = Path.join(current, name);
      const relPath = Path.relative(this.basePath, path);
      if (ig.ignores(relPath)) {
        continue;
      }
      const stat = fs.lstatSync(path);
      if (stat.isDirectory()) {
        this.loadJSFilesRecursive(path, ig);
      } else if (stat.isFile() && EXTENSIONS.includes(Path.extname(name))) {
        const filename = Path.relative(this.basePath, path);
        console.log(`loading JS file ${filename}`);
        const state = new BaseState();
        state.escapin = this;
        state.filename = filename;
        state.code = fs.readFileSync(path, 'utf8');
        state.ast = u.parse(state.code);
        this.states[filename] = state;
      }
    }
  }

  private loadJSFiles() {
    const ignoreFile = Path.join(this.basePath, this.ignorePath);
    const ig = ignore();
    if (fs.existsSync(ignoreFile)) {
      ig.add(fs.readFileSync(ignoreFile, 'utf8'));
    }
    this.loadJSFilesRecursive(this.basePath, ig);
  }

  private saveJSFiles() {
    for (const filename in this.states) {
      this.states[filename].code = u.generate(this.states[filename].ast);
      const path = Path.join(this.config.output_dir, filename);
      fs.writeFileSync(path, this.states[filename].code, 'utf8');
    }
  }

  private updateJSFiles() {
    finalize(this);
    for (const filename in this.states) {
      this.states[filename].code = u.generate(this.states[filename].ast);
      this.states[filename].ast = u.parse(this.states[filename].code);
    }
  }

  private loadServerlessConfig() {
    const serverlessFile = Path.join(this.basePath, SERVERLESS_YML);
    if (fs.existsSync(serverlessFile)) {
      this.serverlessConfig = loadYaml(fs.readFileSync(serverlessFile, 'utf8'));
    } else {
      this.serverlessConfig = {};
    }
    const { name, platform } = this.config;
    this.addServerlessConfig(platform, {
      name,
      platform,
      runtime: 'nodejs10.x',
      stage: 'dev',
    });
  }

  public addServerlessConfig(specifier: string, vars: { [key: string]: any }) {
    const file = Path.resolve(
      __dirname,
      `../templates/serverless/${specifier.replace(/\./g, '/').toLowerCase()}.yml`,
    );
    if (!fs.existsSync(file)) {
      throw new Error(`${file} not found`);
    }
    const tpl = fs.readFileSync(file, 'utf8');
    const context = vm.createContext(vars);
    const yaml = vm.runInContext(`String.raw\`${tpl}\``, context);
    const configPart = loadYaml(yaml);

    mergeWith(this.serverlessConfig, configPart, (lhs: any, rhs: any): any => {
      if (Array.isArray(lhs)) {
        return lhs.concat(rhs);
      }
    });
  }

  private saveServerlessConfig() {
    const serverlessFile = Path.join(this.config.output_dir, SERVERLESS_YML);
    fs.writeFileSync(serverlessFile, dumpYaml(this.serverlessConfig), 'utf8');
  }
}
