# mysqlutils
A library that simplifies working with MySQL databases (it does carry a dependency on the [`mysql`](https://www.npmjs.com/package/mysql)) package. It provides promise-based functions making it easy to get objects out of database table rows with intuitive language.  

# What it does.
Work directly on any table in your mysql database using any of the following functions, summarized as follows:

## Single Row Queries

* __get__ - selects a single row by id
* __exists__ - similar to __get__, but returns a 1 if found or 0 if not found.

## Multiple Row Queries

* __all__ - selects all rows in a table (offset and limit are supported for paging)
* __find__ - selects rows that meet criteria
* __count__ - similar to __find__, but returns a count of the rows that match the criteria
* __one__ - selects and returns only *one* of a list of rows that meet criteria
* __selectWhere__ - same as __find__, but an explicit where clause is used as input.
* __select__ - supports a fully parameterized SQL select statement

## Insert and Update
* __create__ - inserts a row in a table (returns an autogenerated id if applicable)
* __update__ - updates a row in a table by primary key (supports sparse updates)
* __save__ - "upserts" a row in a table (i.e. performs an update if an primary keys match an existing row, else performs an insert)

## Delete

* __delete__ - delete a single row by its id
* __deleteOne__ - same as delete, but supports multi-column primary keys
* __deleteMatching__ - deletes anything that matches the provided criteria
* __deleteWhere__ - deletes anything that matches the provided WHERE clause

# How to use it.

## Instantiate

__Important Prerequsite__: your app should configure a [mysql connection pool](https://www.npmjs.com/package/mysql#pooling-connections) that it can pass to this library. This library is not opinionated about connection management. It does not close or otherwise manage pool connections directly.


```
//var pool = (assumed to be provided by your app)
const MyTable = require('@apigrate/mysqlutils');

//An optional configuration object containing some options that you might want to use on a table.  
//
var opts = {
  created_timestamp_column: 'created',
  updated_timestamp_column: 'updated',
  version_number_column: 'version'
};

var Customer = new MyTable('t_customer', 'customer', opts, pool);
```

## Read/Query

### Get by id.
```
//Get a customer by id=27
Customer.get(27)
.then(function(cust){
  console.log(JSON.stringify(cust));
})
.catch(function(err){
  console.error(err.message);
});

```

### Find
```
//Search for customers where status='active' and city='Chicago'
Customer.find({status: 'active', city: 'Chicago'})
.then(function(customers){
  //customers: an array of customer objects.
  console.log( 'Found ' + customer.length + ' customers.');
})
.catch(function(err){
  console.error(err.message);
});

```

*todo: more examples!*

## Create
*todo: more examples!*

## Update
*todo: more examples!*

## Delete
*todo: more examples!*

## More

### Support for Logging
It is possible (and recommended) to inject a logger when you construct references to your tables. The library currently expects a logger that supports [winston](https://www.npmjs.com/package/winston)-style syntax. Here's an example.

```
//assume MyTable, opts, pool from earlier example

var winston = require('winston');
winston.level='debug';

winston.loggers.add('db', {
  console: {
    level: 'debug',
    colorize: false,
    label: 'db'
  }
});

var logger = winston.loggers.get('db');

var Customer = new MyTable('t_customer', 'customer', opts, pool, logger);


```


#### What gets logged?
1. at __error__ level, error messages (database exceptions)
2. at __warn__ level, currently no warnings are issued, so effectively the same as __error__
3. at __info__ level, currently no info messages are logged, so effectively the same as __warn__
4. at __debug__ level, the following is logged:
  1. method call announcement
  2. SQL used for query/execution
  3. a count of the results (if any).
5. at __silly__ (aka trace) level, the following is logged:
  1. raw SQL command output from the underlying mysql library
