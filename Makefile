export PATH := $(PATH):./node_modules/.bin

.PHONY: test docs

SHELL := env "PATH=$(PATH)" /bin/bash
NPM_PUBLISH_TAG := $(shell [[ "$(CIRCLE_TAG)" =~ -[a-z-]+ ]] && echo "pre-release" || echo "latest")
TEST_BROWSER := $(shell [ -z $(TEST_BROWSER) ] && echo "Chrome" || echo ${TEST_BROWSER})

# intended for local dev
test:
	mocha test/server.js

test-browser:
	@if [ -z $(CI) ]; \
		then karma start --browsers=${TEST_BROWSER}; \
		else karma start --single-run --browsers=${TEST_BROWSER}; \
	fi

test-es5:
	node test/es5.js

test-esm:
	FETCH_MOCK_SRC=../esm/server.js ./node_modules/.bin/mocha test/server.mjs

typecheck:
	dtslint --expectOnly types

lint-ci:
	eslint --ext .js,.mjs --ignore-pattern test/fixtures/* src test
	prettier *.md docs/*.md docs/**/*.md

lint:
	eslint --cache --fix --ext .js,.mjs --ignore-pattern test/fixtures/* src test
	prettier --cache --write *.md docs/*.md docs/**/*.md

verify: lint

coverage:
	nyc --reporter=lcovonly --reporter=text mocha test/server.js
	cat ./coverage/lcov.info | coveralls

local-coverage:
	nyc --reporter=html --reporter=text mocha test/server.js

transpile:
	babel src --out-dir es5

build: transpile
	if [ ! -d "cjs" ]; then mkdir cjs; fi
	cp -r src/* cjs
	rollup -c rollup.config.js
	echo '{"type": "module"}' > esm/package.json

docs:
	cd docs; jekyll serve build --watch

la:
	@echo $(NPM_PUBLISH_TAG)

publish:
	echo "//registry.npmjs.org/:_authToken=${NPM_AUTH_TOKEN}" > ${HOME}/.npmrc
	npm version --no-git-tag-version $(CIRCLE_TAG)
	npm publish --access public --tag $(NPM_PUBLISH_TAG)
