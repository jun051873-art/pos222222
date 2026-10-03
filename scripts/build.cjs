const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process'),babel=require('@babel/core');
const root=path.resolve(__dirname,'..');process.chdir(root);
fs.writeFileSync('app.js',babel.transformSync(fs.readFileSync('app.jsx','utf8'),{plugins:[[require('@babel/plugin-transform-react-jsx'),{runtime:'classic'}]],comments:false,compact:true}).code);
execFileSync(process.execPath,[require.resolve('tailwindcss/lib/cli.js'),'-i','styles.input.css','-o','styles.css','--content','app.jsx','--minify'],{stdio:'inherit'});
for(const pkg of ['react','react-dom']){const base=path.dirname(require.resolve(pkg+'/package.json'));fs.mkdirSync('vendor',{recursive:true});fs.copyFileSync(path.join(base,'umd',pkg+'.production.min.js'),'vendor/'+pkg+'.production.min.js');fs.copyFileSync(path.join(base,'LICENSE'),'vendor/'+pkg+'-LICENSE.txt');}
console.log('Built local React assets, precompiled JSX and CSS.');
