import fs from "fs-extra";
import * as path from "path";
import { validate } from "schema-utils";
import * as tsickle from "tsickle";
import ts from "typescript";
import { EOL } from "os";
import webpack from "webpack";
import { fixCode, fixExtern } from "./fix-output";
import { JSONSchema7 } from "json-schema";
import { RawSourceMap } from "source-map";

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
    }
  }
};

interface RealOptions {
  externDir: string;
  tsconfig: string;
  externFile: string;
  compilerConfig: ReturnType<typeof ts.parseJsonConfigFileContent>;
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
    compilerConfig
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

const tsickleLoader = function (
  this: LoaderCTX,
  _source: string | Buffer
) {
  const {
    compilerConfig: { options },
    externFile
  } = setup(this);

  // normalize the path to unix-style
  const sourceFileName = this.resourcePath.replace(/\\/g, "/");
  const compilerHost = ts.createCompilerHost(options);
  const program = ts.createProgram([sourceFileName], options, compilerHost);
  const diagnostics = ts.getPreEmitDiagnostics(program);

  const diagnosticsHost: ts.FormatDiagnosticsHost = {
    getNewLine: () => EOL,
    getCanonicalFileName: fileName => fileName,
    getCurrentDirectory: () => path.dirname(sourceFileName)
  };

  if (diagnostics.length > 0) {
    handleDiagnostics(this, diagnostics, diagnosticsHost, "error");
    return;
  }

  const tsickleHost: tsickle.TsickleHost = {
    shouldSkipTsickleProcessing: (filename: string) =>
      sourceFileName !== filename,
    shouldIgnoreWarningsForPath: () => false,
    pathToModuleName: (name: string) => name,
    fileNameToModuleId: (name: string) => name,
    options: {}, // TODO: set possible options here
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
    },
    program.getSourceFile(sourceFileName)
  );

  if (transpiledSources.length !== 1) {
    this.emitError(
      Error(`missing compiled result for source file: ${sourceFileName}`)
    );
    return;
  }
  if (this.sourceMap && transpiledSourceMaps.length !== 1) {
    this.emitError(
      Error(`tsconfig must specify sourceMap: "true" when sourcemaps are enabled!`)
    );
    return;
  }

  const extern = output.externs[sourceFileName];
  if (extern != null) {
    fs.appendFileSync(externFile, fixExtern(extern));
  }

  let sourceMap: RawSourceMap | undefined = undefined;
  if (this.sourceMap) {
    sourceMap = JSON.parse(transpiledSourceMaps[0]);
  }
  this.callback(null, fixCode(transpiledSources[0]), sourceMap);
};

export default tsickleLoader;
