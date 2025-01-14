const compiler = require('./compiler.js')
const fs = require('fs-extra')
const path = require('path')
const ClosureCompilerPlugin = require('closure-webpack-plugin')
jest.setTimeout(20000);

test('Converts a simple es6 function', async () => {
  const [output] = await compiler('examples/hello-world.ts')

  expect(output).toContain('@return {string}')
})

test('failed to files with invalid imports', async () => {
  try {
    await compiler('/examples/invalid-import.ts')
  } catch (e) {
    console.info(e)
    expect(e).toBeTruthy()
  }
})

test('Handles imports across files', async () => {
  const [output] = await compiler('examples/single-import.ts')
  expect(output).toContain('importable(count)')
})

test('Can process other module types..', async () => {
  const [output] = await compiler('examples/single-import.ts', {
    tsconfig: path.resolve(__dirname, 'tsconfig.explicit.json')
  })

  expect(output).toContain('importable(count)')
})

test('It will correctly collapse unnecessary modules (tree shaking)', async () => {
  const [output] = await compiler('examples/dual-import.ts', {
    tsconfig: path.resolve(__dirname, 'tsconfig.explicit.json')
  })

  expect(output).toContain('myRealExport')
})

test('will work with closure compiler plugin', async () => {
  const externDir = path.resolve(__dirname, 'tmp', 'externs-' + Math.floor(Math.random() * 10))
  fs.ensureFileSync(path.resolve(externDir, 'externs.js'))

  const rules = [{
    test: /\.tsx?$/,
    use: {
      loader: 'babel-loader',
      options: {
        presets: ['@babel/preset-typescript']
      }
    }
  }]

  const minimizer = [new ClosureCompilerPlugin({
    mode: 'STANDARD',
    childCompilations: true
  }, {
    externs: [path.resolve(externDir, 'externs.js')],
    // language_in: 'ECMASCRIPT6',
    jscomp_off: 'es5Strict',
    jscompOff: 'es5Strict',
    languageOut: 'ECMASCRIPT5',
    // strict_mode_input: false,
    // debug: true,
    compilation_level: 'ADVANCED'
  })]

  const [output] = await compiler('examples/complex-example.ts', {
    tsconfig: path.resolve(__dirname, 'tsconfig.explicit.json'), // use es2015 modules
    mode: 'production',
    rules,
    minimizer,
    externDir
  })

  fs.writeFileSync(path.resolve(__dirname,'tmp/complex-example.js'), output)
  expect(output).toBeTruthy()
}) // this can be *very* slow