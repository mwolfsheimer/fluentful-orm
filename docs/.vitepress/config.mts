import {readFileSync} from 'node:fs';
import {defineConfig} from 'vitepress';

const {version} = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

export default defineConfig({
    title: '@fluentful/orm',
    description: 'Readable, typed DynamoDB operations with worked examples and plain-language explanations.',
    lang: 'en-GB',
    base: '/fluentful-orm/',
    cleanUrls: true,
    themeConfig: {
        nav: [
            {text: 'Get started', link: '/getting-started/first-application'},
            {text: 'Guides', link: '/guides/recipes'},
            {text: 'Concepts', link: '/concepts/'},
            {text: 'Reference', link: '/reference/api'},
            {text: `v${version}`, link: 'https://www.npmjs.com/package/@fluentful/orm'}
        ],
        sidebar: [
        {
                "text": "Get started",
                "collapsed": false,
                "items": [
                        {
                                "text": "Overview",
                                "link": "/"
                        },
                        {
                                "text": "First application",
                                "link": "/getting-started/first-application"
                        },
                        {
                                "text": "Task example setup",
                                "link": "/getting-started/task-setup"
                        },
                        {
                                "text": "Connect to AWS",
                                "link": "/getting-started/aws"
                        }
                ]
        },
        {
                "text": "How-to guides",
                "collapsed": false,
                "items": [
                        {
                                "text": "Worked task recipes",
                                "link": "/guides/recipes"
                        },
                        {
                                "text": "Create, read and delete",
                                "link": "/guides/read-write"
                        },
                        {
                                "text": "Update records",
                                "link": "/guides/updates"
                        },
                        {
                                "text": "Conditional writes",
                                "link": "/guides/conditions"
                        },
                        {
                                "text": "Queries and indexes",
                                "link": "/guides/queries"
                        },
                        {
                                "text": "Scans",
                                "link": "/guides/scans"
                        },
                        {
                                "text": "Select fields and paths",
                                "link": "/guides/projections"
                        },
                        {
                                "text": "Pagination and streaming",
                                "link": "/guides/pagination"
                        },
                        {
                                "text": "Batches and recovery",
                                "link": "/guides/batches"
                        },
                        {
                                "text": "Transactions",
                                "link": "/guides/transactions"
                        },
                        {
                                "text": "Local storage",
                                "link": "/guides/local-storage"
                        },
                        {
                                "text": "Timestamps and logging",
                                "link": "/guides/observability"
                        },
                        {
                                "text": "Troubleshooting",
                                "link": "/guides/troubleshooting"
                        }
                ]
        },
        {
                "text": "Concepts",
                "collapsed": false,
                "items": [
                        {
                                "text": "Concepts overview",
                                "link": "/concepts/index"
                        },
                        {
                                "text": "Fluent API lifecycle",
                                "link": "/concepts/fluent-api"
                        },
                        {
                                "text": "Keys and access patterns",
                                "link": "/concepts/keys-and-access-patterns"
                        },
                        {
                                "text": "Queries and filters",
                                "link": "/concepts/queries-and-filters"
                        },
                        {
                                "text": "Indexes and consistency",
                                "link": "/concepts/indexes-and-consistency"
                        },
                        {
                                "text": "Reliability",
                                "link": "/concepts/reliability"
                        }
                ]
        },
        {
                "text": "Reference",
                "collapsed": false,
                "items": [
                        {
                                "text": "API at a glance",
                                "link": "/reference/api"
                        },
                        {
                                "text": "Typed tables",
                                "link": "/reference/typed-tables"
                        },
                        {
                                "text": "Execution and cancellation",
                                "link": "/reference/execution"
                        },
                        {
                                "text": "Write return modes",
                                "link": "/reference/return-modes"
                        },
                        {
                                "text": "Comparisons",
                                "link": "/reference/comparisons"
                        },
                        {
                                "text": "Values and serialization",
                                "link": "/reference/values"
                        },
                        {
                                "text": "Low-level QueryBuilder",
                                "link": "/reference/query-builder"
                        },
                        {
                                "text": "Table administration",
                                "link": "/reference/table-admin"
                        },
                        {
                                "text": "Errors",
                                "link": "/reference/errors"
                        }
                ]
        },
        {
                "text": "Maintainers",
                "collapsed": false,
                "items": [
                        {
                                "text": "Documentation rules and publishing",
                                "link": "/maintainers/documentation"
                        },
                        {
                                "text": "Testing",
                                "link": "/maintainers/testing"
                        },
                        {
                                "text": "Backend evidence",
                                "link": "/maintainers/evidence"
                        }
                ]
        }
],
        outline: [2, 3],
        search: {provider: 'local'},
        socialLinks: [{icon: 'github', link: 'https://github.com/mwolfsheimer/fluentful-orm'}],
        editLink: {
            pattern: 'https://github.com/mwolfsheimer/fluentful-orm/edit/main/docs/:path',
            text: 'Suggest an edit on GitHub (main branch)'
        },
        footer: {
            message: 'Released under the Apache-2.0 licence.'
        }
    }
});
