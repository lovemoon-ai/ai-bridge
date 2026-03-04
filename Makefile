
build:
	npm run build

build-public:
	mv src/adapters/private .
	npm run build
	mv private src/adapters/

install: build
	npm link

uninstall:
	npm unlink -g @love-moon/ai-bridge

publish: build-public
	bash scripts/publish-npm.sh
