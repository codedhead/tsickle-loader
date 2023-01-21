import fs from "fs-extra";
import * as path from "path";
import { validate } from "schema-utils";
import * as tsickle from "tsickle";
import ts from "typescript";
import { EOL } from "os";
import webpack from "webpack";
import { fixCode, fixExtern } from "./fix-output";
import { JSONSchema7 } from "json-schema";

const LOADER_NAME = "tsickle-loader";
const DEFAULT_EXTERN_DIR = "dist/externs";
const EXTERNS_FILE_NAME = "externs.js";
const DEFAULT_CONFIG_FILE = "tsconfig.json";

const optionsSchema: JSONSchema7 = {
  type: "object",
  properties: {
    tsconfig: {
      anyOf: [
        {
          type: "string"
        },
        {
          type: "boolean"
        }
      ]
    },
    externDir: {
      type: "string"
    },
    skipTsickleProcessing: {
      anyOf: [
        {
          type: "string"
        },
        {
          type: "array",
          items: {
            type: "string"
          }
        }
      ]
    }
  }
};

interface RealOptions {
  externDir: string;
  tsconfig: string;
  externFile: string;
  compilerConfig: ReturnType<typeof ts.parseJsonConfigFileContent>;
  skipTsickleProcessing: string | string[];
}

const setup = (loaderCTX: LoaderCTX): RealOptions => {
  const options = loaderCTX.getOptions();
  validate(optionsSchema, options, { name: LOADER_NAME });

  const externDir =
    options.externDir != null ? options.externDir : DEFAULT_EXTERN_DIR;
  const externFile = path.resolve(externDir, EXTERNS_FILE_NAME);

  fs.ensureDirSync(externDir);
  const tsconfig =
    typeof options.tsconfig === "string"
      ? options.tsconfig
      : DEFAULT_CONFIG_FILE;

  const compilerConfigFile = ts.readConfigFile(
    tsconfig,
    (configPath: string) => {
      return fs.readFileSync(configPath, "utf-8");
    }
  );

  const compilerConfig = ts.parseJsonConfigFileContent(
    compilerConfigFile.config,
    ts.sys,
    path.dirname(tsconfig || ''),
    {},
    tsconfig
  );

  return {
    tsconfig,
    externDir,
    externFile,
    compilerConfig,
    skipTsickleProcessing: options.skipTsickleProcessing,
  };
};

type LoaderCTX = webpack.LoaderContext<RealOptions>;

const handleDiagnostics = (
  ctx: LoaderCTX,
  diagnostics: ReadonlyArray<ts.Diagnostic>,
  diagnosticHost: ts.FormatDiagnosticsHost,
  type: "error" | "warning"
): void => {
  const formatted = ts.formatDiagnosticsWithColorAndContext(
    diagnostics,
    diagnosticHost
  );

  if (type === "error") {
    ctx.emitError(new Error(formatted));
  } else {
    ctx.emitWarning(new Error(formatted));
  }
};

// persisted across files handled by the loader
const externsAlreadyGenerated = new Set();
const tsickleLoader = function (
  this: LoaderCTX,
  _source: string | Buffer
) {
  const {
    compilerConfig: { options },
    externFile,
    skipTsickleProcessing,
  } = setup(this);

  // normalize the path to unix-style
  const sourceFileName = this.resourcePath.replace(/\\/g, "/");
  const rootModulePath = options.rootDir || path.dirname(sourceFileName);
  const compilerHost = ts.createCompilerHost(options);
  const program = ts.createProgram([sourceFileName], options, compilerHost);
  const diagnostics = ts.getPreEmitDiagnostics(program);

  const diagnosticsHost: ts.FormatDiagnosticsHost = {
    getNewLine: () => EOL,
    getCanonicalFileName: fileName => fileName,
    getCurrentDirectory: () => rootModulePath,
  };

  if (diagnostics.length > 0) {
    handleDiagnostics(this, diagnostics, diagnosticsHost, "error");
    return;
  }

  const tsickleHost: tsickle.TsickleHost = {
    shouldSkipTsickleProcessing: (filename: string) => {
      if (externsAlreadyGenerated.has(filename)) {
        return true;
      }
      externsAlreadyGenerated.add(filename);
      // do not skip any
      if (!skipTsickleProcessing || skipTsickleProcessing.length === 0) {
        return false;
      }
      // skip everything except for current source file
      if (skipTsickleProcessing === '*') {
        return sourceFileName !== filename;
      }
      const denyList = (typeof skipTsickleProcessing === 'string') ? [skipTsickleProcessing] : skipTsickleProcessing;
      for (const x of denyList) {
        if (filename.includes(x)) {
          return true;
        }
      }
      return false;
    },
    shouldIgnoreWarningsForPath: () => false,
    pathToModuleName: (context, fileName) =>
      tsickle.pathToModuleName(rootModulePath, context, fileName),
    fileNameToModuleId: (fileName) => path.relative(rootModulePath, fileName),
    options,
    moduleResolutionHost: compilerHost,
    googmodule: false,
    transformDecorators: true,
    transformTypesToClosure: true,
    typeBlackListPaths: new Set(),
    untyped: false,
    logWarning: warning =>
      handleDiagnostics(this, [warning], diagnosticsHost, "warning"),
    generateExtraSuppressions: true,
    rootDirsRelative: (f: string) => f,
  };

  let transpiledSources: string[] = [];
  let transpiledSourceMaps: string[] = [];

  const output = tsickle.emit(
    program,
    tsickleHost,
    (jsFileName: string, contents: string, _writeByteOrderMark: boolean, _onError, tsSourceFiles) => {
      for (const source of tsSourceFiles ?? []) {
        if (source.fileName === sourceFileName) {
          if (jsFileName.endsWith('.map')) {
            transpiledSourceMaps.push(contents);
          } else {
            transpiledSources.push(contents);
          }
        }
      }
    }
  );

  const extern = tsickle.getGeneratedExterns(output.externs, rootModulePath);
  if (transpiledSources.length !== 1 && !extern) {
    this.emitError(
      Error(`missing both compiled code and externs for source file: ${sourceFileName}`)
    );
    return;
  }

  if (extern) {
    fs.appendFileSync(externFile, fixExtern(extern));
  }

  this.callback(null, fixCode(transpiledSources[0] || ''));
};

export default tsickleLoader;
